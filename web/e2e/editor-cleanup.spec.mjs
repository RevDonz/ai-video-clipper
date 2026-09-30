// Rapikan in the transcript panel (plan §7.3, §11.3 T3.5): the review list, its defaults, the
// in-transcript badges, audition, "Terapkan (n)" as one undoable transaction, and the states.
//
// Like the T2.7 transcript spec, the real panel runs in a self-contained harness page (no Next
// server, no login), bundled by transcript/__dev__/bundle.mjs from
// transcript/__dev__/cleanup-harness-entry.jsx. Unlike T2.7's harness, the store is the **real**
// editor store (web/lib/editor/store.mjs) with the real Appendix B commands, over an in-memory
// API that serves the committed c30 context (tests/fixtures/edit_v2/docs/contexts) and its
// Rapikan list as cleanup.py writes it (tests/fixtures/edit_v2/cleanup-c30.json).
//
//   E2E_ALLOW_SKIP=1 E2E_NO_WEB_SERVER=1 npx playwright test e2e/editor-cleanup.spec.mjs \
//     --project=desktop-chromium
//
// AXE_CORE_PATH=<axe.min.js> adds QG-A11Y with the review open (axe-core is not a dependency).
import { expect, test } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HARNESS_HTML, bundleHarness } from "../components/editor/transcript/__dev__/bundle.mjs";
import { auditionRange, cleanupView } from "../components/editor/transcript/cleanup-model.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";

const ORIGIN = "http://editor-harness.test";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contexts = path.join(repoRoot, "tests", "fixtures", "edit_v2", "docs", "contexts");
const WORDS = JSON.parse(readFileSync(path.join(contexts, "c30.words.json"), "utf8"));
const SEED = JSON.parse(readFileSync(path.join(contexts, "c30.seed.json"), "utf8"));
const LISTING = JSON.parse(readFileSync(path.join(repoRoot, "tests", "fixtures", "edit_v2", "cleanup-c30.json"), "utf8")).listing;
const LEXICON = JSON.parse(readFileSync(path.join(repoRoot, "resources", "lexicon", "id-fillers.v1.json"), "utf8"));
const REDUP = JSON.parse(readFileSync(path.join(repoRoot, "resources", "lexicon", "id-reduplication.v1.json"), "utf8"));
const PARTICLES = new Set(LEXICON.protected_particles);
const ENTRY = path.join(repoRoot, "web", "components", "editor", "transcript", "__dev__", "cleanup-harness-entry.jsx");

const normalize = (text) => text.normalize("NFC").toLowerCase().replace(/^[\p{P}\p{S}\s_]+|[\p{P}\p{S}\s_]+$/gu, "");
const textOf = new Map(WORDS.words.map((word) => [word.id, word.t]));
const viewOf = (doc) => cleanupView({ listing: LISTING, doc, words: WORDS, ctx: createContext({ words: WORDS, seed: doc }) });
const VIEW = viewOf(SEED);
const byKind = (kind, view = VIEW) => view.entries.filter((entry) => entry.kind === kind);

// The seed's body holds no listed repeat; this document starts the body three words before the
// first one (at a `bounds` frame, as TrimStart would), so every class is on screen.
const firstRepeat = LISTING.items.find((item) => item.kind === "repeat");
const earlier = WORDS.words[WORDS.words.findIndex((word) => word.id === firstRepeat.wordIds[0]) - 3];
const EXTENDED = structuredClone(SEED);
EXTENDED.main.segments.find((segment) => segment.role === "body").in_sf = WORDS.bounds.find((entry) => entry.before === earlier.id).sf;
const VIEW_EXTENDED = viewOf(EXTENDED);

function pinnedChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}

const chrome = process.env.PARITY_CHROME || pinnedChrome();

function axeSource() {
  const explicit = process.env.AXE_CORE_PATH;
  if (explicit && existsSync(explicit)) return readFileSync(explicit, "utf8");
  try {
    return readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  } catch {
    return null;
  }
}
const AXE = axeSource();
test.use({ launchOptions: chrome ? { executablePath: chrome } : {}, viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1 });

let bundle = null;
test.beforeAll(async () => {
  bundle = await bundleHarness({ entry: ENTRY });
});

async function openHarness(page, config = {}, { routes = {} } = {}) {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HARNESS_HTML });
    if (pathname === "/harness.js") return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: bundle });
    if (routes[pathname]) return routes[pathname](route);
    return route.fulfill({ status: 404, body: "" });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript((value) => { window.__HARNESS_CONFIG__ = value; },
    { words: WORDS, doc: SEED, cleanup: LISTING, ...config });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.__harness?.ready === true);
  return errors;
}

const transcript = (page) => page.locator('[data-panel="transcript"]');
const review = (page) => page.getByRole("region", { name: "Rapikan" });
const toggle = (page) => transcript(page).getByRole("button", { name: /^Rapikan/ });
const row = (page, id) => review(page).locator(`[data-cleanup-item="${id}"]`);

async function openReview(page) {
  await toggle(page).click();
  await expect(review(page)).toBeVisible();
}

async function doc(page) {
  return page.evaluate(() => window.__harness.store.getState().doc);
}

// The owner's dark palette (DESIGN.md: background, surface, line, text, muted text, one lime
// accent) as editor tokens. The status colours for a dark surface are stand-ins until the editor
// tokens switch; the point is that the panel is built on tokens, so it follows them.
const DARK_TOKENS = Object.freeze({
  "--ed-color-bg": "#080907", "--ed-color-surface": "#11120f", "--ed-color-surface-2": "#1c1d19",
  "--ed-color-border": "#292b25", "--ed-color-text": "#f7f5ed", "--ed-color-text-muted": "#a5a69d",
  "--ed-color-accent": "#dfff58", "--ed-color-accent-strong": "#ecff9c", "--ed-color-accent-soft": "#2b3112",
  "--ed-color-accent-text": "#080907", "--ed-color-danger": "#ff8a7d", "--ed-color-danger-soft": "#3b1612",
  "--ed-color-warning": "#f2b84b", "--ed-color-warning-text": "#f2b84b", "--ed-color-warning-soft": "#33260f",
  "--ed-color-success": "#7ad99a", "--ed-color-success-soft": "#13301e", "--ed-color-cold-open": "#b89cff",
  "--ed-color-cold-open-soft": "#251c3d", "--ed-color-stage-surface": "#1a1d24", "--ed-color-removed": "#77796f",
  "--ed-focus-ring": "0 0 0 2px #11120f, 0 0 0 4px #dfff58",
});

// Every visible text in the transcript panel (the review included) against the background it is
// drawn on, WCAG 2 contrast: [{text, ratio, large}] below the AA bar (4.5:1, 3:1 for large text).
async function lowContrast(page) {
  // colours are measured once the hover and theme transitions have settled
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  return page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const paint = canvas.getContext("2d", { willReadFrequently: true });
    const rgba = (value) => {
      paint.clearRect(0, 0, 1, 1);
      paint.fillStyle = "#000";
      paint.fillStyle = value;
      paint.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a), a: 1,
    });
    const background = (element) => {
      const layers = [];
      for (let node = element; node; node = node.parentElement) {
        const colour = rgba(getComputedStyle(node).backgroundColor);
        if (colour.a > 0) layers.push(colour);
        if (colour.a >= 1) break;
      }
      return layers.reduceRight((below, layer) => over(layer, below), { r: 255, g: 255, b: 255, a: 1 });
    };
    const luminance = ({ r, g, b }) => [r, g, b].map((v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    const failures = [];
    for (const element of document.querySelectorAll('[data-panel="transcript"] *')) {
      const own = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
      if (!own || element.closest(":disabled") || !element.getClientRects().length) continue;
      const style = getComputedStyle(element);
      if (style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      const back = background(element);
      const fore = over(rgba(style.color), back);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      const value = ratio(fore, back);
      if (value < (large ? 3 : 4.5)) failures.push({ text: element.textContent.trim().slice(0, 40), ratio: Number(value.toFixed(2)), large });
    }
    return failures;
  });
}

test.describe("Rapikan review", () => {
  test("the button counts the open items and the review groups them with honest copy", async ({ page }) => {
    const errors = await openHarness(page, { doc: EXTENDED });
    await expect(toggle(page)).toHaveText(new RegExp(`Rapikan.*${VIEW_EXTENDED.entries.length}`));
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "false");
    await openReview(page);
    await expect(toggle(page)).toHaveAttribute("aria-expanded", "true");
    for (const [kind, label] of [["filler", "Kata pengisi"], ["repeat", "Pengulangan"], ["gap_silent", "Jeda hening"], ["gap_voiced", "Jeda bersuara"]]) {
      const count = byKind(kind, VIEW_EXTENDED).length;
      expect(count, kind).toBeGreaterThan(0);
      await expect(review(page).getByRole("group", { name: new RegExp(`^${label} \\(${count}\\)`) })).toBeVisible();
    }
    await expect(review(page)).toContainText("Transkrip otomatis sering tidak menulis “eh” atau “em”");
    // the locked items say why they are not proposed
    const quietless = LISTING.locked.filter((entry) => entry.reason === "no_quiet_cut").length;
    expect(quietless).toBeGreaterThan(0);
    await expect(review(page)).toContainText(`${quietless} saran tidak diusulkan: tidak ada titik potong yang hening`);
    await expect(review(page).locator("[data-cleanup-item]")).toHaveCount(VIEW_EXTENDED.entries.length);
    // a repeat shows the removed occurrence struck through and the kept one after it
    const repeat = byKind("repeat", VIEW_EXTENDED)[0];
    await expect(row(page, repeat.id).locator("del")).toHaveText(repeat.context.removed);
    expect(errors).toEqual([]);
  });

  test("fillers and repeats start unchecked, silent gaps checked; voiced gaps are audition only", async ({ page }) => {
    await openHarness(page);
    await openReview(page);
    for (const entry of VIEW.entries) {
      const checkbox = row(page, entry.id).getByRole("checkbox");
      if (entry.kind === "gap_voiced") {
        await expect(checkbox).toHaveCount(0);
        await expect(row(page, entry.id).getByRole("button", { name: /^Putar/ })).toBeVisible();
      } else if (entry.kind === "gap_silent") await expect(checkbox).toBeChecked();
      else await expect(checkbox).not.toBeChecked();
    }
    await expect(review(page).getByRole("button", { name: `Terapkan (${byKind("gap_silent").length})` })).toBeEnabled();
  });

  test("protected particles and reduplication are never listed", async ({ page }) => {
    await openHarness(page);
    await openReview(page);
    const listed = await review(page).locator("[data-cleanup-item]").evaluateAll((rows) => rows.flatMap((element) => (element.dataset.words || "").split(" ").filter(Boolean)));
    expect(listed.length).toBeGreaterThan(0);
    const redup = new Set(REDUP.pairs.map((pair) => pair.split(" ")[0]));
    for (const id of listed) {
      expect(PARTICLES.has(normalize(textOf.get(id))), textOf.get(id)).toBe(false);
      const index = WORDS.words.findIndex((word) => word.id === id);
      const next = WORDS.words[index + 1];
      if (next && normalize(next.t) === normalize(textOf.get(id))) expect(redup.has(normalize(textOf.get(id)))).toBe(false);
    }
  });

  test("with the review open the transcript marks the words and gaps of the open items", async ({ page }) => {
    await openHarness(page);
    await expect(transcript(page).locator("[data-cleanup]")).toHaveCount(0);
    await openReview(page);
    const wordMarks = VIEW.entries.flatMap((entry) => entry.wordIdx);
    await expect(transcript(page).locator("[data-w][data-cleanup]")).toHaveCount(wordMarks.length);
    for (const index of wordMarks.slice(0, 5)) {
      await expect(transcript(page).locator(`[data-w="${index}"]`)).toHaveAttribute("data-cleanup", /filler|repeat/);
    }
    const gaps = VIEW.entries.filter((entry) => !entry.wordIdx.length);
    await expect(transcript(page).locator("[data-cleanup-gap]")).toHaveCount(gaps.length);
    await toggle(page).click();
    await expect(transcript(page).locator("[data-cleanup]")).toHaveCount(0);
  });

  test("Terapkan (n) applies the checked items as one undoable transaction", async ({ page }) => {
    await openHarness(page);
    await openReview(page);
    await review(page).getByRole("group", { name: /^Kata pengisi/ }).getByRole("button", { name: "Pilih semua" }).click();
    const checked = byKind("filler").length + byKind("gap_silent").length;
    const apply = review(page).getByRole("button", { name: `Terapkan (${checked})` });
    await apply.click();
    await expect(review(page).getByRole("status")).toContainText(`${checked} saran diterapkan`);
    const after = await doc(page);
    expect(after.audit.last_command).toBe("ApplyCleanup");
    expect(after.main.removals.length).toBeGreaterThan(0);
    expect(after.main.removals.every((removal) => removal.origin.startsWith("suggestion:cl_"))).toBe(true);
    expect(new Set(after.main.removals.map((removal) => removal.reason))).toEqual(new Set(["filler", "gap_silent"]));
    const history = await page.evaluate(() => ({ canUndo: window.__harness.store.getState().canUndo, commands: window.__harness.store.getState().commands.map((step) => step.type) }));
    expect(history).toEqual({ canUndo: true, commands: ["ApplyCleanup"] });
    await expect(transcript(page).locator("button[data-removal-id]")).toHaveCount(after.main.removals.length);
    for (const entry of [...byKind("filler"), ...byKind("gap_silent")]) await expect(row(page, entry.id)).toHaveCount(0);
    await expect(review(page)).toContainText(`${checked} sudah diterapkan`);
    // one undo restores everything
    await page.evaluate(() => window.__harness.store.undo());
    expect((await doc(page)).main.removals).toEqual([]);
    await expect(transcript(page).locator("button[data-removal-id]")).toHaveCount(0);
    await expect(review(page).locator("[data-cleanup-item]")).toHaveCount(VIEW.entries.length);
  });

  test("Putar plays the item with context and stops by itself", async ({ page }) => {
    await openHarness(page, { doc: EXTENDED });
    await openReview(page);
    const entry = byKind("repeat", VIEW_EXTENDED)[0];
    const model = buildTranscriptModel(WORDS, EXTENDED);
    const range = auditionRange(entry, model);
    await row(page, entry.id).getByRole("button", { name: /^Putar/ }).click();
    await expect.poll(() => page.evaluate(() => window.__harness.player.seeks.at(-1))).toBe(range.from);
    await expect.poll(() => page.evaluate(() => window.__harness.player.state().playing)).toBe(true);
    const seconds = ((range.to - range.from) * SEED.output.fps[1]) / SEED.output.fps[0];
    await expect.poll(() => page.evaluate(() => window.__harness.player.state().playing), { timeout: (seconds + 3) * 1000 }).toBe(false);
    const stopped = await page.evaluate(() => window.__harness.player.state().frame);
    expect(stopped).toBeGreaterThanOrEqual(range.to - 3);
    expect(stopped).toBeLessThanOrEqual(range.to + 12);
  });

  test("Lihat selects the item's words in the transcript", async ({ page }) => {
    await openHarness(page);
    await openReview(page);
    const entry = byKind("filler")[0];
    await row(page, entry.id).getByRole("button", { name: /^Lihat/ }).click();
    for (const index of entry.wordIdx) await expect(transcript(page).locator(`[data-w="${index}"]`)).toHaveAttribute("data-selected", "");
  });

  test("read-only clips list the items but apply nothing", async ({ page }) => {
    await openHarness(page, { readOnly: true });
    await openReview(page);
    await expect(review(page).getByRole("button", { name: /^Terapkan/ })).toBeDisabled();
    for (const checkbox of await review(page).getByRole("checkbox").all()) await expect(checkbox).toBeDisabled();
  });

  test("a failed list offers a retry; an empty list says so; missing audio analysis is named", async ({ page }) => {
    await openHarness(page, { cleanupFailures: 1 });
    await openReview(page);
    await expect(review(page)).toContainText("Daftar Rapikan belum tersedia");
    await review(page).getByRole("button", { name: "Coba lagi" }).click();
    await expect(review(page).locator("[data-cleanup-item]")).toHaveCount(VIEW.entries.length);
  });

  test("an empty list and a job without audio analysis", async ({ page }) => {
    await openHarness(page, { cleanup: { ...LISTING, items: [], locked: [], missing: ["audio_timeline"] } });
    await expect(toggle(page)).toHaveText(/Rapikan/);
    await openReview(page);
    await expect(review(page)).toContainText("Tidak ada yang perlu dirapikan di klip ini.");
    await expect(review(page)).toContainText("Jeda hening tidak tersedia untuk job ini");
  });

  test("the review names no engine or version and keeps its copy plain", async ({ page }) => {
    await openHarness(page, { doc: EXTENDED });
    await openReview(page);
    const text = await transcript(page).innerText();
    expect(text).not.toMatch(/whisper|editor v\d|\bv\d\b|versi|mesin (?:lama|baru)|—/i);
    const titles = await transcript(page).locator("[title]").evaluateAll((nodes) => nodes.map((node) => node.title).join(" | "));
    expect(titles).not.toMatch(/whisper|\bv\d\b|versi|mesin/i);
    await expect(review(page).getByRole("group", { name: /^Jeda bersuara/ }))
      .toContainText("Masih ada suara di jeda ini, jadi tidak dipotong otomatis. Dengarkan dulu.");
  });

  test("the text stays readable on the editor's tokens, light and the owner's dark palette", async ({ page }) => {
    await openHarness(page, { doc: EXTENDED });
    await openReview(page);
    await transcript(page).locator('[data-w][data-zone="body"]').nth(2).click();
    await page.mouse.move(1300, 700);
    expect(await lowContrast(page)).toEqual([]);
    await page.evaluate((tokens) => {
      const root = document.querySelector("#root > div");
      for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
    }, DARK_TOKENS);
    const surface = await review(page).evaluate((node) => getComputedStyle(node).backgroundColor);
    expect(surface).toBe("rgb(17, 18, 15)");
    expect(await lowContrast(page)).toEqual([]);
  });

  test("one accent: only Terapkan carries the accent colour", async ({ page }) => {
    await openHarness(page, { doc: EXTENDED });
    await openReview(page);
    const accent = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ed-color-accent)";
      document.querySelector("#root > div").append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    });
    const apply = review(page).getByRole("button", { name: /^Terapkan/ });
    await page.mouse.move(1300, 700);
    await expect(apply).toHaveCSS("background-color", accent);
    const painted = await transcript(page).locator("*").evaluateAll((nodes, colour) => nodes.filter((node) => {
      if (node.matches("button") && /^Terapkan/.test(node.textContent)) return false;
      const style = getComputedStyle(node);
      return [style.backgroundColor, style.borderTopColor, style.color].includes(colour);
    }).map((node) => node.outerHTML.slice(0, 80)), accent);
    expect(painted).toEqual([]);
  });

  test("the review eases in, and not at all with reduced motion", async ({ page }) => {
    await openHarness(page);
    await openReview(page);
    const moving = await review(page).evaluate((node) => getComputedStyle(node).animationName);
    expect(moving).not.toBe("none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await toggle(page).click();
    await openReview(page);
    const still = await review(page).evaluate((node) => {
      const style = getComputedStyle(node);
      return { name: style.animationName, duration: style.animationDuration };
    });
    expect(still.name === "none" || still.duration === "0s").toBe(true);
  });

  test("QG-A11Y: axe finds no critical or serious violation with the review open", async ({ page }) => {
    test.skip(!AXE, "set AXE_CORE_PATH to an axe.min.js (axe-core is not a web dependency)");
    await openHarness(page, { doc: EXTENDED });
    await openReview(page);
    await review(page).getByRole("group", { name: /^Kata pengisi/ }).getByRole("checkbox").first().check();
    await page.addScriptTag({ content: AXE });
    const serious = async () => page.evaluate(async () => {
      const result = await window.axe.run(document, { resultTypes: ["violations"] });
      return result.violations.filter((item) => ["critical", "serious"].includes(item.impact))
        .map((item) => ({ id: item.id, impact: item.impact, targets: item.nodes.slice(0, 3).map((node) => node.target.join(" ")) }));
    });
    expect(await serious()).toEqual([]);
    await page.evaluate((tokens) => {
      const root = document.querySelector("#root > div");
      for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);
    }, DARK_TOKENS);
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    expect(await serious()).toEqual([]);
  });

  test("without an api prop the panel asks the route itself, only when opened", async ({ page }) => {
    const calls = [];
    const url = `/api/jobs/${SEED.base.job_id}/clips/${SEED.clip_id}/cleanup`;
    await openHarness(page, { apiProp: false }, { routes: { [url]: (route) => {
      calls.push(route.request().url());
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LISTING) });
    } } });
    await expect(toggle(page)).toHaveText(/^Rapikan$/);
    expect(calls).toEqual([]);
    await openReview(page);
    await expect(review(page).locator("[data-cleanup-item]")).toHaveCount(VIEW.entries.length);
    expect(calls.length).toBe(1);
  });
});
