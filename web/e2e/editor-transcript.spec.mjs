// Transcript, text panel and cold-open panel (plan §11.2 T2.7, Appendix C.2, §5.4, §3.4).
//
// The real panel components run in a self-contained harness page (no Next server, no login):
// `transcript/__dev__/bundle.mjs` compiles them with Next's SWC binding and mounts them from the
// real registry (panels/index.mjs) over a harness store that implements the Appendix B
// commands (transcript/__dev__/harness-store.mjs) and a player whose frames advance in real time.
//
//   E2E_ALLOW_SKIP=1 E2E_NO_WEB_SERVER=1 npx playwright test e2e/editor-transcript.spec.mjs \
//     --project=desktop-chromium
//
// The browser is the parity pin, Chrome for Testing 147.0.7727.15 (Playwright build 1217), when
// installed; PARITY_CHROME overrides it. With T27_EVIDENCE_DIR set, the gate tests (scripted
// QG-UX U2 and U3, and the 1,500-word command budget) write their numbers there. T27_REAL_CLIPS
// (a prepared job's analysis/clips directory, read from a copy) adds the budget on real clips.
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HARNESS_HTML, bundleHarness } from "../components/editor/transcript/__dev__/bundle.mjs";
import { DEMO, dataset, unitWords } from "../components/editor/transcript/__dev__/harness-data.mjs";

const ORIGIN = "http://editor-harness.test";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const evidenceDir = process.env.T27_EVIDENCE_DIR || "";

function pinnedChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

const chrome = process.env.PARITY_CHROME || pinnedChrome();
test.use({
  launchOptions: chrome ? { executablePath: chrome } : {},
  viewport: { width: 1366, height: 768 },
  deviceScaleFactor: 1,
});

const demo = dataset("demo");
const demoWords = demo.words.words;
const unit = (index) => unitWords(demo.words, index);
const textOf = ([first, last]) => demoWords.slice(first, last + 1).map((word) => word.t).join(" ");
const idsOf = ([first, last]) => demoWords.slice(first, last + 1).map((word) => word.id);

let bundle = null;
test.beforeAll(async () => {
  bundle = await bundleHarness();
});

async function openHarness(page, config = {}) {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HARNESS_HTML });
    if (pathname === "/harness.js") return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: bundle });
    return route.fulfill({ status: 404, body: "" });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript((value) => { window.__HARNESS_CONFIG__ = value; }, config);
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.__harness?.ready === true);
  return errors;
}

const transcript = (page) => page.locator('[data-panel="transcript"]');
const word = (page, index) => transcript(page).locator(`[data-w="${index}"]`);
const wordList = (page) => transcript(page).locator("[data-transcript-words]");
const toolbar = (page) => page.getByRole("toolbar", { name: "Aksi kata" });

async function commands(page) {
  return page.evaluate(() => window.__harness.store.log.filter((entry) => entry.ok)
    .map(({ type, args, mergeKey }) => ({ type, args, mergeKey })));
}

async function lastCommand(page) {
  return (await commands(page)).at(-1) ?? null;
}

async function currentDoc(page) {
  return page.evaluate(() => window.__harness.store.getState().doc);
}

async function selectRange(page, first, last) {
  await word(page, first).click();
  if (last !== first) await word(page, last).click({ modifiers: ["Shift"] });
}

async function openTab(page, name) {
  await page.getByRole("tab", { name }).click();
}

function writeEvidence(name, value) {
  if (!evidenceDir) return;
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, name), `${JSON.stringify(value, null, 2)}\n`);
}

function environment(browser) {
  let commit = null;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    commit = null;
  }
  return {
    browser: browser.browserType().name(), browserVersion: browser.version(), executable: chrome ? "chromium-1217 (Chrome for Testing)" : "playwright default",
    machine: { cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model ?? null, loadavg: os.loadavg().map((value) => Number(value.toFixed(2))) },
    commit, harness: "web/components/editor/transcript/__dev__ (production React, harness store)",
  };
}

// --- behaviour --------------------------------------------------------------------------------

test.describe("transcript panel", () => {
  test("mounts from the registry and lays out the clip with dimmed context", async ({ page }) => {
    const errors = await openHarness(page);
    await expect(page.getByRole("tab", { name: "Transkrip" })).toHaveAttribute("aria-selected", "true");
    await expect(transcript(page).locator("[data-w]")).toHaveCount(demoWords.length);
    await expect(transcript(page).locator("[data-unit]")).toHaveCount(demo.words.units.length);
    const [beforeFirst, beforeLast] = unit(DEMO.contextBefore);
    const [afterFirst] = unit(DEMO.contextAfter);
    await expect(word(page, beforeFirst)).toHaveAttribute("data-zone", "before");
    await expect(word(page, beforeLast)).toHaveAttribute("data-zone", "before");
    await expect(word(page, afterFirst)).toHaveAttribute("data-zone", "after");
    await expect(word(page, unit(DEMO.bodyFirst)[0])).toHaveAttribute("data-zone", "body");
    for (let i = unit(DEMO.seedColdOpen)[0]; i <= unit(DEMO.seedColdOpen)[1]; i += 1) {
      await expect(word(page, i)).toHaveAttribute("data-cold", "");
    }
    await expect(word(page, demoWords.findIndex((entry) => entry.t === "Security-nya"))).toHaveAttribute("data-lowconf", "");
    await expect(wordList(page)).toHaveAttribute("role", "group");
    expect(errors).toEqual([]);
  });

  test("delete words → removal, chip and restore; undo updates the transcript", async ({ page }) => {
    await openHarness(page);
    const [first] = unit(DEMO.bodyFirst + 1);
    await selectRange(page, first, first + 2);
    await expect(transcript(page).locator("[data-selected]")).toHaveCount(3);
    await page.keyboard.press("Delete");
    expect(await lastCommand(page)).toEqual({ type: "RemoveWords",
      args: { wordIds: idsOf([first, first + 2]), reason: "user", origin: "user" }, mergeKey: expect.any(String) });
    for (let i = first; i <= first + 2; i += 1) await expect(word(page, i)).toHaveAttribute("data-removed", /^rm_/);
    const chip = transcript(page).locator("button[data-removal-id]");
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText(/^⋯ \d+,\d dtk$/);
    const removalId = await chip.getAttribute("data-removal-id");
    await chip.click();
    expect(await lastCommand(page)).toEqual({ type: "RestoreRemoval", args: { removalId }, mergeKey: null });
    await expect(chip).toHaveCount(0);
    await expect(word(page, first)).not.toHaveAttribute("data-removed", /.*/);
    await selectRange(page, first, first + 1);
    await page.keyboard.press("Backspace");
    await expect(transcript(page).locator("button[data-removal-id]")).toHaveCount(1);
    await page.evaluate(() => window.__harness.store.undo());
    await expect(transcript(page).locator("button[data-removal-id]")).toHaveCount(0);
    await expect(word(page, first)).not.toHaveAttribute("data-removed", /.*/);
  });

  test("a delete over removed and kept words removes each kept run as one undo step", async ({ page }) => {
    await openHarness(page);
    const [first] = unit(DEMO.ramble);
    await selectRange(page, first + 2, first + 3);
    await page.keyboard.press("Delete");
    await selectRange(page, first, first + 6);
    await expect(toolbar(page).getByRole("button", { name: "Pulihkan" })).toBeEnabled();
    await toolbar(page).getByRole("button", { name: "Hapus" }).click();
    const doc = await currentDoc(page);
    const body = doc.main.removals.filter((removal) => removal.seg === "seg_b1");
    expect(body).toHaveLength(1);
    expect(body[0].words).toEqual(idsOf([first, first + 6]));
    const removeCommands = (await commands(page)).filter((entry) => entry.type === "RemoveWords");
    expect(removeCommands).toHaveLength(3);
    expect(removeCommands[1].mergeKey).toBe(removeCommands[2].mergeKey);
    const history = await page.evaluate(() => window.__harness.store.history());
    expect(history.filter((entry) => entry.type === "RemoveWords")).toHaveLength(2);
  });

  test("edit a word's text inline: Enter saves, Tab moves on, Esc cancels", async ({ page }) => {
    await openHarness(page);
    const [first] = unit(DEMO.bodyFirst);
    await word(page, first).dblclick();
    const editor = transcript(page).locator("input[data-word-editor]");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveValue(demoWords[first].t);
    await editor.fill("Mengapa");
    await editor.press("Enter");
    expect(await lastCommand(page)).toEqual({ type: "EditWordText", args: { wordId: demoWords[first].id, text: "Mengapa" },
      mergeKey: `word:${demoWords[first].id}` });
    await expect(word(page, first)).toHaveText("Mengapa");
    await expect(word(page, first)).toHaveAttribute("data-edited", "");
    await expect(word(page, first)).toHaveAttribute("title", new RegExp(demoWords[first].t));
    await word(page, first + 1).click();
    await page.keyboard.press("Enter");
    await expect(editor).toHaveValue(demoWords[first + 1].t);
    await editor.fill("Sutradara");
    await editor.press("Tab");
    expect(await lastCommand(page)).toMatchObject({ type: "EditWordText", args: { wordId: demoWords[first + 1].id, text: "Sutradara" } });
    await expect(editor).toHaveValue(demoWords[first + 2].t);
    const before = (await commands(page)).length;
    await editor.fill("xxx");
    await editor.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(word(page, first + 2)).toHaveText(demoWords[first + 2].t);
    expect((await commands(page)).length).toBe(before);
    await expect(wordList(page)).toBeFocused();
  });

  test("hide a word from captions and mark a keyword", async ({ page }) => {
    await openHarness(page);
    const index = unit(DEMO.bodyFirst)[0] + 1;
    await word(page, index).click();
    await page.keyboard.press("Control+Shift+X");
    expect(await lastCommand(page)).toEqual({ type: "SetWordHidden", args: { wordId: demoWords[index].id, on: true }, mergeKey: expect.any(String) });
    await expect(word(page, index)).toHaveAttribute("data-hidden", "");
    await expect(toolbar(page).getByRole("button", { name: "Sembunyikan" })).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Control+Shift+X");
    expect(await lastCommand(page)).toMatchObject({ type: "SetWordHidden", args: { on: false } });
    await expect(word(page, index)).not.toHaveAttribute("data-hidden", /.*/);
    await page.keyboard.press("Control+e");
    expect(await lastCommand(page)).toMatchObject({ type: "SetWordEmphasis", args: { wordId: demoWords[index].id, on: true } });
    await expect(word(page, index)).toHaveAttribute("data-emphasis", "");
    await expect(word(page, index)).toHaveCSS("color", "rgb(255, 92, 138)");
  });

  test("set the trim from the transcript and extend it back with 'Perpanjang ke sini'", async ({ page }) => {
    await openHarness(page);
    const [secondFirst] = unit(DEMO.bodyFirst + 1);
    await word(page, secondFirst).click();
    await page.keyboard.press("i");
    expect(await lastCommand(page)).toEqual({ type: "TrimStart", args: { gapWord: demoWords[secondFirst].id }, mergeKey: null });
    const [firstFirst] = unit(DEMO.bodyFirst);
    await expect(word(page, firstFirst)).toHaveAttribute("data-zone", "before");
    await word(page, firstFirst).click();
    await toolbar(page).getByRole("button", { name: "Perpanjang ke sini" }).click();
    expect(await lastCommand(page)).toEqual({ type: "TrimStart", args: { gapWord: demoWords[firstFirst].id }, mergeKey: null });
    await expect(word(page, firstFirst)).toHaveAttribute("data-zone", "body");
    const [, penultimateLast] = unit(DEMO.bodyLast - 1);
    await word(page, penultimateLast).click();
    await page.keyboard.press("o");
    expect(await lastCommand(page)).toEqual({ type: "TrimEnd", args: { gapWord: demoWords[penultimateLast].id }, mergeKey: null });
    await expect(word(page, unit(DEMO.bodyLast)[0])).toHaveAttribute("data-zone", "after");
  });

  test("a rejected command names its reason and changes nothing", async ({ page }) => {
    await openHarness(page);
    await selectRange(page, unit(DEMO.bodyFirst)[0], unit(DEMO.bodyLast)[1]);
    await page.keyboard.press("Delete");
    await expect(transcript(page).locator("[data-transcript-message]")).toContainText("3 dtk");
    expect((await currentDoc(page)).main.removals).toEqual([]);
  });

  test("arrows move the selection, shift+arrows extend it, Escape clears it", async ({ page }) => {
    await openHarness(page);
    const [first] = unit(DEMO.bodyFirst);
    await word(page, first).click();
    await expect(wordList(page)).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect(transcript(page).locator("[data-selected]")).toHaveCount(1);
    await expect(word(page, first + 2)).toHaveAttribute("data-selected", "");
    await page.keyboard.press("Shift+ArrowRight");
    await expect(transcript(page).locator("[data-selected]")).toHaveCount(2);
    await expect(transcript(page).locator("[data-transcript-status]")).toContainText("2 kata dipilih");
    await page.keyboard.press("Shift+ArrowDown");
    expect(await transcript(page).locator("[data-selected]").count()).toBeGreaterThan(2);
    await page.keyboard.press("Escape");
    await expect(transcript(page).locator("[data-selected]")).toHaveCount(0);
  });

  test("the active word follows playback, and a click while playing seeks", async ({ page }) => {
    await openHarness(page);
    const [first] = unit(DEMO.bodyFirst);
    await word(page, first + 3).click();
    await expect(word(page, first + 3)).toHaveAttribute("data-active", "");
    await page.evaluate(() => window.__harness.player.play());
    await expect.poll(async () => Number(await transcript(page).locator("[data-active]").getAttribute("data-w")),
      { timeout: 5000 }).toBeGreaterThan(first + 5);
    await expect(transcript(page).locator("[data-active]")).toHaveCount(1);
    const seeks = await page.evaluate(() => window.__harness.player.seeks.length);
    const target = unit(DEMO.bodyLast)[0];
    await word(page, target).click();
    expect(await page.evaluate(() => window.__harness.player.seeks.length)).toBe(seeks + 1);
    await expect.poll(async () => Number(await transcript(page).locator("[data-active]").getAttribute("data-w")))
      .toBeGreaterThanOrEqual(target);
    await page.evaluate(() => window.__harness.player.pause());
  });

  test("read-only: nothing can be dispatched", async ({ page }) => {
    await openHarness(page, { readOnly: true });
    const [first] = unit(DEMO.bodyFirst);
    await word(page, first).click();
    await page.keyboard.press("Delete");
    await expect(toolbar(page).getByRole("button", { name: "Hapus" })).toBeDisabled();
    await openTab(page, "Teks");
    await expect(page.getByRole("switch", { name: "Tampilkan caption" })).toBeDisabled();
    await openTab(page, "Cold open");
    await expect(page.getByRole("switch", { name: "Cold open aktif" })).toBeDisabled();
    expect(await commands(page)).toEqual([]);
  });
});

test.describe("cold-open panel", () => {
  test("make a cold open from a selection, nudge its edges and turn it off", async ({ page }) => {
    await openHarness(page);
    const coldOpen = unit(DEMO.newColdOpen);
    await selectRange(page, coldOpen[0], coldOpen[1]);
    await page.keyboard.press("Control+Shift+H");
    expect(await lastCommand(page)).toEqual({ type: "SetColdOpen",
      args: { firstWord: demoWords[coldOpen[0]].id, lastWord: demoWords[coldOpen[1]].id }, mergeKey: null });
    await expect(word(page, coldOpen[0])).toHaveAttribute("data-cold", "");
    await expect(word(page, unit(DEMO.seedColdOpen)[0])).not.toHaveAttribute("data-cold", /.*/);
    await openTab(page, "Cold open");
    const panel = page.locator('[data-panel="coldopen"]');
    await expect(panel.locator("[data-coldopen-line]")).toHaveText(`“${textOf(coldOpen)}”`);
    await expect(panel.locator("[data-coldopen-length]")).toHaveText(/^\d+,\d dtk$/);
    await panel.getByRole("button", { name: "Buang kata terakhir" }).click();
    expect(await lastCommand(page)).toEqual({ type: "NudgeColdOpen", args: { edge: "out", words: -1 }, mergeKey: "co:out" });
    await expect(panel.locator("[data-coldopen-line]")).toHaveText(`“${textOf([coldOpen[0], coldOpen[1] - 1])}”`);
    await panel.getByRole("button", { name: "Tambah kata sebelum" }).click();
    expect(await lastCommand(page)).toEqual({ type: "NudgeColdOpen", args: { edge: "in", words: -1 }, mergeKey: "co:in" });
    await panel.getByRole("switch", { name: "Cold open aktif" }).click();
    expect(await lastCommand(page)).toEqual({ type: "SetColdOpen", args: null, mergeKey: null });
    await expect(panel.locator("[data-coldopen-line]")).toHaveCount(0);
    expect((await currentDoc(page)).main.segments.map((segment) => segment.role)).toEqual(["body"]);
  });

  test("'Jadikan cold open' is disabled with its reason outside 0.5–8 s", async ({ page }) => {
    await openHarness(page);
    const [first] = unit(DEMO.bodyFirst + 1);
    const [, last] = unit(DEMO.seedColdOpen);
    await selectRange(page, first, last);
    await expect(toolbar(page).getByRole("button", { name: "Jadikan cold open" })).toBeDisabled();
    await openTab(page, "Cold open");
    const panel = page.locator('[data-panel="coldopen"]');
    await expect(panel.getByRole("button", { name: "Jadikan cold open dari pilihan" })).toBeDisabled();
    await expect(panel.locator("[data-coldopen-reason]")).toContainText("maksimal 8 dtk");
    await openTab(page, "Transkrip");
    const [single] = unit(DEMO.newColdOpen);
    await word(page, single).click();
    await expect(toolbar(page).getByRole("button", { name: "Jadikan cold open" })).toBeDisabled();
    await openTab(page, "Cold open");
    await expect(panel.locator("[data-coldopen-reason]")).toContainText("minimal 0,5 dtk");
  });
});

test.describe("text panel", () => {
  test("switch packs; every pack has its thumbnail", async ({ page }) => {
    await openHarness(page, { panel: "text" });
    const packs = page.getByRole("group", { name: "Gaya caption" });
    await expect(packs.getByRole("radio")).toHaveCount(4);
    await expect(packs.getByRole("radio", { name: "Karaoke" })).toBeChecked();
    await packs.getByRole("radio", { name: "Bold" }).check();
    expect(await lastCommand(page)).toEqual({ type: "SetCaptionPack", args: { id: "bold" }, mergeKey: null });
    await expect(packs.getByRole("radio", { name: "Bold" })).toBeChecked();
    const sizes = await packs.locator("img").evaluateAll((images) => images.map((image) => [image.naturalWidth, image.naturalHeight]));
    expect(sizes).toEqual([[320, 80], [320, 80], [320, 80], [320, 80]]);
    await page.getByRole("switch", { name: "Tampilkan caption" }).click();
    expect(await lastCommand(page)).toEqual({ type: "SetCaptionsEnabled", args: { on: false }, mergeKey: null });
  });

  test("position, size, uppercase and the two swatch sets", async ({ page }) => {
    await openHarness(page, { panel: "text" });
    const position = page.getByRole("slider", { name: "Posisi caption" });
    await position.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const doc = await currentDoc(page);
    expect(doc.captions.overrides.y_e5).toBeLessThan(83000);
    expect(await lastCommand(page)).toMatchObject({ type: "SetCaptionOverride", args: { key: "y_e5" }, mergeKey: "cap:y_e5" });
    const history = await page.evaluate(() => window.__harness.store.history());
    expect(history.filter((entry) => entry.mergeKey === "cap:y_e5")).toHaveLength(1);
    const size = page.getByRole("slider", { name: "Ukuran caption" });
    await size.focus();
    await page.keyboard.press("ArrowRight");
    expect(await lastCommand(page)).toMatchObject({ type: "SetCaptionOverride", args: { key: "size_pm" }, mergeKey: "cap:size_pm" });
    expect((await currentDoc(page)).captions.overrides.size_pm).toBeGreaterThan(1000);
    await page.getByRole("checkbox", { name: "Huruf besar semua" }).check();
    expect(await lastCommand(page)).toMatchObject({ type: "SetCaptionOverride", args: { key: "case", value: "upper" } });
    await page.getByRole("group", { name: "Warna sorot" }).getByRole("radio", { name: "Hijau" }).check();
    expect(await lastCommand(page)).toMatchObject({ type: "SetCaptionOverride", args: { key: "highlight", value: "#3DF5A6" } });
    await page.getByRole("group", { name: "Warna kata kunci" }).getByRole("radio", { name: "Biru" }).check();
    expect(await lastCommand(page)).toMatchObject({ type: "SetCaptionOverride", args: { key: "emphasis", value: "#52C7FF" } });
  });

  test("hook text with counter and fit badge; duration, position and on/off", async ({ page }) => {
    await openHarness(page, { panel: "text" });
    const text = page.getByRole("textbox", { name: "Teks hook" });
    const long = "Ini hook yang sengaja dibuat sangat panjang supaya tidak muat di tiga baris layar ponselmu";
    expect([...long].length).toBe(90);
    await text.fill(long);
    await expect(page.locator("[data-hook-counter]")).toHaveText("90/90");
    await expect(page.locator("[data-hook-fit]")).toHaveText("Akan terpotong");
    expect(await lastCommand(page)).toMatchObject({ type: "SetHookText", args: { text: long, origin: "user" }, mergeKey: "hook:text" });
    await text.fill("Dia ditahan security ");
    await expect(page.locator("[data-hook-counter]")).toHaveText("20/90");
    await expect(page.locator("[data-hook-fit]")).toHaveText("Muat");
    expect((await currentDoc(page)).tracks[0].items[0].payload.text).toBe("Dia ditahan security");
    const duration = page.getByRole("slider", { name: "Durasi hook" });
    await duration.focus();
    await page.keyboard.press("ArrowRight");
    expect(await lastCommand(page)).toMatchObject({ type: "SetHookDuration", mergeKey: "hook:dur_f" });
    const y = page.getByRole("slider", { name: "Posisi hook" });
    await y.focus();
    await page.keyboard.press("ArrowRight");
    expect(await lastCommand(page)).toMatchObject({ type: "SetHookY", mergeKey: "hook:y_e5" });
    await page.getByRole("switch", { name: "Tampilkan hook" }).click();
    expect(await lastCommand(page)).toEqual({ type: "SetHookEnabled", args: { on: false }, mergeKey: null });
    await expect(text).toBeDisabled();
    await page.getByRole("switch", { name: "Tampilkan hook" }).click();
    expect(await lastCommand(page)).toEqual({ type: "SetHookEnabled", args: { on: true, text: "Dia ditahan security" }, mergeKey: null });
  });
});

// --- gates ------------------------------------------------------------------------------------

// Keystroke-level model (Card, Moran & Newell) for a human doing the same steps: M mental
// preparation 1.35 s, P point 1.1 s, B button press or release 0.1 s, K keystroke 0.28 s.
// Reading time to find the passage is not included.
const KLM = { M: 1.35, P: 1.1, B: 0.1, K: 0.28 };
function klmSeconds(operators) {
  return Number(operators.split(" ").reduce((sum, op) => {
    const match = /^(\d*)([MPBK])$/.exec(op);
    return sum + (match[1] ? Number(match[1]) : 1) * KLM[match[2]];
  }, 0).toFixed(2));
}

for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
  test.describe(`gates at ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport });

    test("QG-UX U2 (scripted): remove a 5 s ramble via the transcript ≤ 20 s", async ({ page, browser }) => {
      await openHarness(page);
      const ramble = unit(DEMO.ramble);
      const started = Date.now();
      await word(page, ramble[0]).click();
      await word(page, ramble[1]).click({ modifiers: ["Shift"] });
      await page.keyboard.press("Delete");
      await expect(transcript(page).locator("button[data-removal-id]")).toHaveCount(1);
      const elapsedMs = Date.now() - started;
      const doc = await currentDoc(page);
      const removal = doc.main.removals.find((entry) => entry.seg === "seg_b1");
      const removedS = ((removal.out_sf - removal.in_sf) * doc.output.fps[1]) / doc.output.fps[0];
      expect(removedS).toBeGreaterThan(4.5);
      expect(removedS).toBeLessThan(6.5);
      expect(elapsedMs).toBeLessThanOrEqual(20_000);
      const operators = "M P 2B M K P 2B K M K M";
      writeEvidence(`T2.7-QG-UX-U2-${viewport.width}x${viewport.height}.json`, {
        gate: "QG-UX U2 (scripted e2e)", task: "remove a 5 s ramble via the transcript", limit_s: 20,
        viewport, elapsed_s: elapsedMs / 1000, removed_s: Number(removedS.toFixed(3)), words_removed: removal.words.length,
        user_actions: { clicks: 2, keys: 1 }, klm_operators: operators, klm_estimate_s: klmSeconds(operators),
        pass: elapsedMs <= 20_000, ...environment(browser),
      });
    });

    test("QG-UX U3 (scripted): replace the cold open ≤ 45 s", async ({ page, browser }) => {
      await openHarness(page);
      const next = unit(DEMO.newColdOpen);
      const started = Date.now();
      await openTab(page, "Cold open");
      await expect(page.locator("[data-coldopen-line]")).toHaveText(`“${textOf(unit(DEMO.seedColdOpen))}”`);
      await openTab(page, "Transkrip");
      await word(page, next[0]).click();
      await word(page, next[1]).click({ modifiers: ["Shift"] });
      await page.keyboard.press("Control+Shift+H");
      await openTab(page, "Cold open");
      await expect(page.locator("[data-coldopen-line]")).toHaveText(`“${textOf(next)}”`);
      const elapsedMs = Date.now() - started;
      const doc = await currentDoc(page);
      const co = doc.main.segments.find((segment) => segment.role === "cold_open");
      const lengthS = ((co.out_sf - co.in_sf) * doc.output.fps[1]) / doc.output.fps[0];
      expect(lengthS).toBeGreaterThanOrEqual(0.5);
      expect(lengthS).toBeLessThanOrEqual(8);
      expect(elapsedMs).toBeLessThanOrEqual(45_000);
      const operators = "M P 2B M P 2B M P 2B K M K M 3K M P 2B M";
      writeEvidence(`T2.7-QG-UX-U3-${viewport.width}x${viewport.height}.json`, {
        gate: "QG-UX U3 (scripted e2e)", task: "replace the cold open", limit_s: 45, viewport,
        elapsed_s: elapsedMs / 1000, cold_open_s: Number(lengthS.toFixed(3)),
        user_actions: { clicks: 4, keys: 1 }, klm_operators: operators, klm_estimate_s: klmSeconds(operators),
        pass: elapsedMs <= 45_000, ...environment(browser),
      });
    });
  });
}


// In the page: time `rounds` rounds of seven commands, each from its DOM event (or the store's
// undo) to the React commit plus a forced style and layout of the transcript.
async function measureCommands({ rounds }) {
  const list = document.querySelector("[data-transcript-words]");
  const settle = async (check) => {
    for (let i = 0; i < 6 && !check(); i += 1) await Promise.resolve();
    let frames = 0;
    while (!check() && frames < 30) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      frames += 1;
    }
    void list.offsetHeight; // style and layout of the updated transcript
    return check();
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const span = (i) => list.querySelector(`[data-w="${i}"]`);
  const mouse = (target, type, init = {}) => target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init }));
  const click = (i, init = {}) => {
    const target = span(i);
    if (!target) throw new Error(`word ${i} is not rendered (${list.querySelectorAll("[data-w]").length} words shown)`);
    mouse(target, "mousedown", { buttons: 1, ...init });
    mouse(target, "mouseup", init);
    mouse(target, "click", init);
  };
  const key = (k, init = {}) => list.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  // Body words not in the cold open, spread over the clip.
  const bodyWords = [...list.querySelectorAll('[data-w][data-zone="body"]:not([data-cold])')].map((node) => Number(node.dataset.w));
  const out = { RemoveWords: [], RestoreRemoval: [], SetWordEmphasis: [], SetWordHidden: [], EditWordText: [], TrimStart: [], Undo: [] };
  let unsettled = 0;
  const time = async (name, act, check) => {
    const t0 = performance.now();
    act();
    const done = await settle(check);
    out[name].push(performance.now() - t0);
    if (!done) unsettled += 1;
  };
  await new Promise((resolve) => setTimeout(resolve, 300));
  for (let k = 0; k < rounds; k += 1) {
    const first = bodyWords[Math.floor(((k + 0.5) * (bodyWords.length - 40)) / rounds) + 30];
    click(first);
    click(first + 4, { shiftKey: true });
    await tick();
    await time("RemoveWords", () => key("Delete"), () => span(first).hasAttribute("data-removed"));
    const chip = list.querySelector("button[data-removal-id]");
    await time("RestoreRemoval", () => chip.click(), () => !span(first).hasAttribute("data-removed"));
    click(first + 1);
    await tick();
    await time("SetWordEmphasis", () => key("e", { ctrlKey: true }), () => span(first + 1).hasAttribute("data-emphasis"));
    await time("SetWordHidden", () => key("X", { ctrlKey: true, shiftKey: true }), () => span(first + 1).hasAttribute("data-hidden"));
    key("Enter");
    await tick();
    const input = list.querySelector("input[data-word-editor]");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, `kata${k}`);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await time("EditWordText", () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })),
      () => span(first + 1)?.textContent === `kata${k}`);
    const trimAt = bodyWords[5 + k];
    click(trimAt);
    await tick();
    await time("TrimStart", () => key("i"), () => span(trimAt - 1)?.dataset.zone === "before");
    await time("Undo", () => window.__harness.store.undo(), () => span(trimAt - 1)?.dataset.zone === "body");
  }
  return { out, unsettled, spans: list.querySelectorAll("[data-w]").length };
}

function summarise(out) {
  const stats = (samples) => {
    const sorted = [...samples].sort((a, b) => a - b);
    const pick = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
    return { n: sorted.length, p50_ms: Number(pick(0.5).toFixed(2)), p95_ms: Number(pick(0.95).toFixed(2)), max_ms: Number(sorted.at(-1).toFixed(2)) };
  };
  const perCommand = Object.fromEntries(Object.entries(out).map(([name, samples]) => [name, stats(samples)]));
  return { overall: stats(Object.values(out).flat()), perCommand };
}

async function unfoldContext(page) {
  await expect(transcript(page).locator('[data-w][data-zone="body"]').first()).toBeVisible();
  for (const name of [/Tampilkan \d+ kalimat sebelumnya/, /Tampilkan \d+ kalimat sesudahnya/]) {
    const toggle = transcript(page).getByRole("button", { name });
    if (await toggle.count()) await toggle.click();
  }
}

const BUDGET = {
  gate: "a command on a 1,500-word window updates the transcript", threshold_ms: 16, statistic: "p95 per command and overall",
  measured: "keydown/click dispatch → store command → React commit → forced style and layout of the transcript (in-page performance.now)",
};

test.describe("gates: command budget", () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("a command on a 1,500-word window updates the transcript in ≤ 16 ms", async ({ page, browser }) => {
    test.setTimeout(180_000);
    const errors = await openHarness(page, { dataset: "long1500" });
    await unfoldContext(page);
    await expect(transcript(page).locator("[data-w]")).toHaveCount(1500);
    const results = await page.evaluate(measureCommands, { rounds: 20 });
    const { overall, perCommand } = summarise(results.out);
    writeEvidence("T2.7-PF-TRANSCRIPT-1500.json", {
      ...BUDGET, words: results.spans, viewport: { width: 1920, height: 1080 }, overall, per_command: perCommand,
      unsettled: results.unsettled, pass: results.unsettled === 0 && Object.values(perCommand).every((entry) => entry.p95_ms <= 16),
      ...environment(browser),
    });
    expect(errors).toEqual([]);
    expect(results.spans).toBe(1500);
    expect(results.unsettled).toBe(0);
    for (const [name, entry] of Object.entries(perCommand)) expect(entry.p95_ms, name).toBeLessThanOrEqual(16);
  });

  // Supplementary: the same budget on real clips (seed.json + words.<sha>.json of a prepared
  // job, one directory per clip under T27_REAL_CLIPS). Nothing but counts and timings is kept.
  const realRoot = process.env.T27_REAL_CLIPS || "";
  const realClips = realRoot && existsSync(realRoot)
    ? readdirSync(realRoot).filter((name) => /^clip_[0-9a-f]{24}$/.test(name)).sort() : [];
  test("the same budget on real prepared clips (T27_REAL_CLIPS)", async ({ page, browser }) => {
    test.skip(realClips.length === 0, "T27_REAL_CLIPS names no prepared clip directories");
    test.setTimeout(300_000);
    const clips = [];
    for (const clip of realClips) {
      const dir = path.join(realRoot, clip);
      const wordsFile = readdirSync(dir).find((name) => /^words\.[0-9a-f]{16}\.json$/.test(name));
      const words = JSON.parse(readFileSync(path.join(dir, wordsFile), "utf8"));
      const doc = JSON.parse(readFileSync(path.join(dir, "seed.json"), "utf8"));
      const errors = await openHarness(page, { words, doc });
      await unfoldContext(page);
      await expect(transcript(page).locator("[data-w]")).toHaveCount(words.words.length);
      const results = await page.evaluate(measureCommands, { rounds: 10 });
      const { overall, perCommand } = summarise(results.out);
      clips.push({ words: results.spans, fps: doc.output.fps, cold_open: doc.main.segments.length > 1, overall, per_command: perCommand,
        unsettled: results.unsettled, page_errors: errors.length });
      expect(errors).toEqual([]);
      expect(results.unsettled).toBe(0);
      for (const [name, entry] of Object.entries(perCommand)) expect(entry.p95_ms, `${clip} ${name}`).toBeLessThanOrEqual(16);
      await page.unrouteAll({ behavior: "ignoreErrors" });
    }
    writeEvidence("T2.7-PF-TRANSCRIPT-real.json", {
      ...BUDGET, supplementary: true, source: "prepared V3 clips of a real job (read-only copy)", clips,
      pass: clips.every((clip) => clip.unsettled === 0 && Object.values(clip.per_command).every((entry) => entry.p95_ms <= 16)),
      ...environment(browser),
    });
  });
});
