// Mode Cepat's cards (docs/plans/2026-10-02-editor-mode-cepat.md §1.2–§1.4, §3, §4.1, §9.4 task B):
// AC5 (one model per control, the same notes in both views), AC7 (the hook hint), AC13 for the
// cards (44 px targets, axe, forced-colours focus, reduced motion), AC16 (a face analysis and a
// music upload outlive the card and the view), AC17 (every hook-suggestion state and the privacy
// line; no /ai request on load), each card's controls changing the preview's plan, and U3, U4, U5
// scripted in Cepat (U5 with its unchanged stop condition: the music lane shows the lowered line).
//
// Two parts:
// 1. The harness page (no Next server, no login): EditorApp on the real store and the real
//    Appendix B commands over the fake API (gizmos/__dev__/logo-harness-entry.jsx, bundled by
//    transcript/__dev__/bundle.mjs), opened at `?mode=cepat`. The init script below patches the
//    fake API and preview client through the `window.__harness` assignment, before the store's
//    first plan: a caption TikTok-zone warning at the seed spot (K5), the music envelope, slow
//    camera analysis and uploads, and the hook suggestions' answers.
// 2. The editor fakes behind the Next server (E2E_EDITOR_FAKES=1, login): the app's own CSS,
//    reduced motion, and lime nowhere in the cards.
//
// Evidence: EDITOR_GATES_OUT=<dir> receives the axe results, the 44 px measurements and the
// scripted U3, U4 and U5 timings. AXE_CORE_PATH=<axe.min.js> runs the axe checks.
// On GitHub Actions: gh workflow run editor-gates.yml -f ref=<branch> -f suite=e2e \
//   -f command='e2e/editor-quick.spec.mjs'
import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakeSha256, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { HARNESS_HTML, bundleHarness } from "../components/editor/transcript/__dev__/bundle.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { CARD_IDS, openCard } from "./support/editor-cards.mjs";
import { login, settings } from "./support/harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = path.join(repoRoot, "web", "components", "editor", "gizmos", "__dev__", "logo-harness-entry.jsx");
const ORIGIN = "http://editor-quick.test";
const CEPAT_URL = `${ORIGIN}/?mode=cepat`;
const SERVER_CEPAT_URL = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit?mode=cepat`;
const gatesOut = process.env.EDITOR_GATES_OUT || "";
const LIMITS_MS = Object.freeze({ U3: 45_000, U4: 30_000, U5: 60_000 }); // docs/editor/UJI-PENERIMAAN.md

function pinnedChrome() {
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

const chrome = process.env.PARITY_CHROME || process.env.EDITOR_CHROME || pinnedChrome();
const AXE = axeSource();
test.use({
  launchOptions: { ...(chrome ? { executablePath: chrome } : {}), args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] },
  viewport: { width: 1366, height: 650 },
  deviceScaleFactor: 1,
});

function writeGate(name, value) {
  if (!gatesOut) return;
  mkdirSync(gatesOut, { recursive: true });
  writeFileSync(path.join(gatesOut, name), `${JSON.stringify(value, null, 2)}\n`);
}

// --- documents and files (made at run time; no media in git) -----------------------------------------

const CTX = createContext({ words: fakeWords(), seed: fakeDoc() });
// The fakes' seed with a cold open set by the real SetColdOpen (Kilat putih + whoosh, as the auto clips).
const COLD = applyCommand(fakeDoc(), "SetColdOpen", { firstWord: "w048127", lastWord: "w048132" }, CTX).doc;
// A cold-open candidate the clip can use (the fakes' own one repeats the opening of the clip).
const CANDIDATES = { candidates: [{ id: "co_2", firstWord: "w048127", lastWord: "w048132", durMs: 2080, reason: "kalimat terkuat" }] };
const INSTANT = [
  { id: "hk_1", text: "Kenapa sutradara ditahan?", source: "ai_selection", fits: true },
  { id: "hk_2", text: "Sutradara ditahan di film sendiri", source: "heuristic", fits: true },
  { id: "hk_3", text: "Jadi waktu itu kita datang subuh dan langsung ditahan di depan pintu masuk belakang", source: "heuristic", fits: false },
];
// The fakes' own second hook suggestion has the same text (fakes.mjs FAKE_HOOKS hk_2).
const INSTANT_FAKE_SECOND = INSTANT[1].text;
const AI = [{ id: "ai_7c9e66790", text: "Sutradara nggak bisa masuk ke film sendiri", source: "llm", fits: true, style: "klaim",
  basis: "Kenapa sutradara ditahan di film sendiri?" }];
const TASK_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

function chunk(kind, payload) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(kind, "latin1"), payload])) >>> 0);
  return Buffer.concat([length, Buffer.from(kind, "latin1"), payload, crc]);
}

/** A small opaque RGBA PNG of one colour. */
function solidPng(width, height) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 4);
    for (let x = 0; x < width; x += 1) row.set([63, 94, 251, 255], 1 + x * 4);
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const LOGO = { name: "logo-cepat.png", mimeType: "image/png", buffer: solidPng(96, 96) };
const MUSIC = { name: "lagu-cepat.m4a", mimeType: "audio/mp4", buffer: Buffer.from("fake m4a bytes") };

// --- browser side (serialised by addInitScript) ---------------------------------------------------------

function installQuick(config) {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
  window.__quick = { musicUploads: [] };

  // Music uploads: the Logo & Musik card and the Musik panel resolve the scenario's uploadAsset.
  window.__potonginEditorScenario = {
    async uploadAsset(jobId, file, kind, { onProgress = () => {}, signal } = {}) {
      window.__quick.musicUploads.push({ name: file.name, kind });
      for (const part of [0.25, 0.5, 1]) {
        await wait(config.musicStepMs ?? 30, signal);
        onProgress(part);
      }
      await wait(config.musicStepMs ?? 30, signal);
      const sha = Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(file.name.length * 7 + i * 3) % 16]).join("");
      return { sha256: sha, kind: "music", mime: "audio/mp4", w: null, h: null, durationMs: 95_000, lufsC: -1620,
        peaksUrl: `/api/jobs/${jobId}/assets/${sha}?part=peaks` };
    },
  };

  // A stand-in for the server's music envelope: one duck span at [2 s, 4 s) when ducking is on.
  function gainPoints(doc, samples) {
    const item = doc.tracks.find((track) => track.kind === "audio")?.items?.[0];
    if (!item) return [];
    const p = item.payload;
    const g = Math.round(10 ** (p.gain_cdb / 2000) * 1e6);
    const low = p.duck.on ? Math.round(g * 10 ** (-p.duck.depth_cdb / 2000)) : g;
    return [[0, g], [96_000 - 1440, g], [96_000, low], [192_000, low], [192_000 + 19_200, g], [samples, g]];
  }

  function patch(harness) {
    const api = harness.api;
    const preview = harness.runtime.previewClient;
    const plan = preview.plan.bind(preview);
    preview.plan = async (doc) => {
      const dto = await plan(doc);
      // The caption at the auto clip's spot sits in the TikTok zone (K5): the server warns there.
      if (doc.captions.enabled && doc.captions.overrides.y_e5 >= 80_000) {
        dto.warnings = [...dto.warnings, { code: "unsafe_zone", path: "/captions/overrides/y_e5", f: 3 }];
      }
      dto.audio = { ...dto.audio, musicGainPoints: gainPoints(doc, dto.audio.samples) };
      return dto;
    };
    if (config.coldOpen) {
      api.coldOpenSuggestions = async () => {
        api.calls.push({ name: "coldOpenSuggestions", args: [] });
        return clone(config.coldOpen);
      };
    }
    if (config.prepareMs) {
      let started = null;
      let ready = false;
      api.prepare = async (options = {}) => {
        api.calls.push({ name: "prepare", args: [clone(options)] });
        if (options.layout === "camera" && !ready) {
          started = Date.now();
          await wait(config.prepareMs);
          started = null;
          ready = true;
        }
        return { words: "ready", camera: options.layout === "camera" ? "ready" : "not_needed", plate: { state: "ready", ready: 1, total: 1 } };
      };
      api.cameraProgress = async () => (started === null
        ? { state: ready ? "ready" : "none" }
        : { state: "building", done: Math.min(240, Math.floor(((Date.now() - started) / config.prepareMs) * 240)), total: 240 });
    }
    if (config.ai) {
      let hooks = 0;
      let polls = 0;
      api.aiHooks = async () => {
        hooks += 1;
        api.calls.push({ name: "aiHooks", args: [] });
        if (config.ai.failFirst && hooks === 1) throw Object.assign(new Error("offline"), { status: 0, code: "network_error" });
        return clone(config.ai.answer);
      };
      api.aiTask = async (taskId) => {
        polls += 1;
        api.calls.push({ name: "aiTask", args: [taskId] });
        if (polls < (config.ai.pendingPolls ?? 1)) return { state: "pending", suggestions: [], error: null };
        return clone(config.ai.task ?? { state: "pending", suggestions: [], error: null });
      };
    }
  }

  let current = null;
  Object.defineProperty(window, "__harness", {
    configurable: true,
    get: () => current,
    set(value) {
      current = value;
      patch(value);
    },
  });
}

// --- the harness page --------------------------------------------------------------------------------

let bundle = null;
async function harnessBundle() {
  bundle ??= await bundleHarness({ entry: ENTRY });
  return bundle;
}

async function openQuick(page, config = {}) {
  const script = await harnessBundle();
  const logoSha = fakeSha256(`asset:logo:${LOGO.name}:${LOGO.buffer.length}`);
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/") return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: HARNESS_HTML });
    if (pathname === "/harness.js") return route.fulfill({ status: 200, contentType: "text/javascript; charset=utf-8", body: script });
    if (pathname.endsWith(`/assets/${logoSha}`)) return route.fulfill({ status: 200, contentType: "image/png", body: LOGO.buffer });
    return route.fulfill({ status: 404, body: "" });
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) errors.push(message.text());
  });
  const { harness = {}, ...quick } = config;
  await page.addInitScript((value) => { window.__HARNESS_CONFIG__ = value; }, harness);
  await page.addInitScript(installQuick, quick);
  await page.goto(CEPAT_URL);
  await page.waitForFunction(() => window.__harness?.ready === true);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible();
  await expect(page.locator("[data-editor-root]")).toHaveAttribute("data-editor-view", "cepat");
  return errors;
}

const region = (page, id) => page.locator(`#card-${id}-region`);
const header = (page, id) => page.locator(`#card-${id}-button`);
const docOf = (page) => page.evaluate(() => window.__harness.store.getState().doc);
const sent = (page) => page.evaluate(() => window.__harness.log.filter((entry) => entry.ok)
  .map((entry) => ({ type: entry.type, args: entry.args, mergeKey: entry.mergeKey })));
const lastSent = async (page) => (await sent(page)).at(-1);
const apiCalls = (page, name) => page.evaluate((wanted) => window.__harness.api.calls.filter((call) => call.name === wanted).length, name);

/** Waits until the preview's plan is the current document's (the stage shows what the card set). */
async function planFollows(page) {
  await expect.poll(async () => {
    const { doc, planDoc, pending } = await page.evaluate(() => {
      const state = window.__harness.store.getState();
      return { doc: state.doc, planDoc: state.plan?.docSha256 ?? null, pending: state.pending };
    });
    return pending.length === 0 && planDoc === fakeSha256(JSON.stringify(doc));
  }, { timeout: 10_000 }).toBe(true);
  return page.evaluate(() => window.__harness.store.getState().plan);
}

/** Opens Mode Lengkap through a card's own way there, then the tab `tab`. */
async function toLengkap(page, tab) {
  await openCard(page, "extras");
  await region(page, "extras").locator('[data-extras="logo"]').getByRole("button", { name: "Atur detail di Mode Lengkap" }).click();
  await expect(page.locator("[data-editor-root]")).toHaveAttribute("data-editor-view", "lengkap");
  if (tab) await page.getByRole("tab", { name: tab, exact: true }).click();
}

// --- harness tests -------------------------------------------------------------------------------------

test.describe("Mode Cepat cards (harness: real store and commands)", () => {
  test("R1: opening Cepat asks no AI and no cold-open candidates; the Hook card asks once, for both views", async ({ page }) => {
    const errors = await openQuick(page);
    await expect(header(page, "caption")).toHaveAttribute("aria-expanded", "true");
    await page.waitForTimeout(500);
    expect(await apiCalls(page, "aiHooks")).toBe(0);
    expect(await apiCalls(page, "coldOpenSuggestions")).toBe(0);
    await openCard(page, "hook");
    await expect(region(page, "hook").getByRole("list", { name: "Saran otomatis" }).getByRole("button")).toHaveCount(2);
    expect(await apiCalls(page, "aiHooks")).toBe(1);
    await openCard(page, "caption");
    await openCard(page, "hook");
    await toLengkap(page, "Teks");
    await expect(page.locator('[data-panel="text"] [data-hook-suggestions]')).toBeVisible();
    await expect(page.getByRole("list", { name: "Saran otomatis" }).getByRole("listitem")).toHaveCount(2);
    expect(await apiCalls(page, "aiHooks")).toBe(1);
    writeGate("B-R1.json", { gate: "R1 (no LLM request on load in Mode Cepat; one per clip across views)", aiHooksOnLoad: 0,
      aiHooksAfterHookCardAndPanel: 1, pass: true });
    expect(errors).toEqual([]);
  });

  test("Caption card: each control sends the panel's command, the plan follows, presets press their pill", async ({ page }) => {
    const errors = await openQuick(page);
    const card = region(page, "caption");
    await expect(header(page, "caption")).toContainText("Karaoke · Sedang · Bawah");
    await expect(card.getByRole("group", { name: "Ukuran" }).getByRole("radio", { name: "Sedang" })).toBeChecked();
    await expect(card.getByRole("group", { name: "Posisi" }).getByRole("radio", { name: "Bawah" })).toBeChecked();
    // The packs are the FFmpeg thumbnails, one radio each.
    const packs = card.getByRole("group", { name: "Gaya caption" });
    await expect(packs.getByRole("radio")).toHaveCount(4);
    await expect.poll(() => packs.locator("img").evaluateAll((images) => images.map((image) => image.naturalWidth))).toEqual([320, 320, 320, 320]);

    await packs.getByRole("radio", { name: "Bold" }).check();
    expect(await lastSent(page)).toEqual({ type: "SetCaptionPack", args: { id: "bold" }, mergeKey: null });
    await card.getByRole("group", { name: "Warna sorot" }).getByRole("radio", { name: "Hijau" }).check();
    expect(await lastSent(page)).toEqual({ type: "SetCaptionOverride", args: { key: "highlight", value: "#3DF5A6" }, mergeKey: null });
    await expect(card.getByText("Kata yang sedang diucapkan.")).toBeVisible();
    await card.getByRole("group", { name: "Ukuran" }).getByRole("radio", { name: "Besar" }).check();
    expect(await lastSent(page)).toEqual({ type: "SetCaptionOverride", args: { key: "size_pm", value: 1200 }, mergeKey: null });
    await card.getByRole("group", { name: "Posisi" }).getByRole("radio", { name: "Tengah" }).check();
    expect(await lastSent(page)).toEqual({ type: "SetCaptionOverride", args: { key: "y_e5", value: 60000 }, mergeKey: null });
    await expect(header(page, "caption")).toContainText("Bold · Besar · Tengah");
    // Bold's own case is upper case (SetCaptionPack), and the preview's cues follow it.
    let plan = await planFollows(page);
    expect(plan.cues.map((cue) => cue.text)).toEqual(["KENAPA SUTRADARA DITAHAN DI", "FILM SENDIRI? JADI WAKTU", "ITU KITA DATANG SUBUH"]);
    // Box does not light the spoken word: the note says the colour is unused there.
    await packs.getByRole("radio", { name: "Box" }).check();
    await expect(card.getByText("Dipakai oleh Karaoke dan Bold; tidak tampak di gaya ini.")).toBeVisible();

    await card.getByRole("switch", { name: "Tampilkan caption" }).click();
    expect(await lastSent(page)).toEqual({ type: "SetCaptionsEnabled", args: { on: false }, mergeKey: null });
    plan = await planFollows(page);
    expect(plan.cues).toEqual([]);
    await expect(header(page, "caption")).toContainText("Mati");
    await page.getByRole("button", { name: "Urungkan" }).click();
    await expect(card.getByRole("switch", { name: "Tampilkan caption" })).toBeChecked();

    // A size or position set off the presets (a Lengkap slider) presses no pill and shows its percent.
    await page.evaluate(() => {
      window.__harness.store.dispatch("SetCaptionOverride", { key: "size_pm", value: 920 }, { mergeKey: "cap:size_pm" });
      window.__harness.store.dispatch("SetCaptionOverride", { key: "y_e5", value: 72000 }, { mergeKey: "cap:y_e5" });
    });
    for (const name of ["Kecil", "Sedang", "Besar"]) await expect(card.getByRole("group", { name: "Ukuran" }).getByRole("radio", { name })).not.toBeChecked();
    for (const name of ["Atas", "Tengah", "Bawah"]) await expect(card.getByRole("group", { name: "Posisi" }).getByRole("radio", { name })).not.toBeChecked();
    await expect(header(page, "caption")).toContainText("Box · 92% · posisi 72%");
    expect(errors).toEqual([]);
  });

  test("AC5 and AC7: the zone notes and the hook hint read the same in the Caption card and the Teks panel", async ({ page }) => {
    const errors = await openQuick(page);
    const card = region(page, "caption");
    const hint = "Caption dekat teks hook. Kalau bertumpuk di pratinjau, turunkan caption.";
    // At the seed spot the zone is a calm note (K5); no hook hint.
    await expect(card.locator('[data-caption-zone="note"]')).toHaveText("Posisi bawaan, dekat tombol TikTok. Kalau tertutup, geser caption ke atas.");
    await expect(card.locator("[data-hook-near]")).toHaveCount(0);
    const position = card.getByRole("group", { name: "Posisi" });
    await position.getByRole("radio", { name: "Atas" }).check();
    await expect(card.locator("[data-hook-near]")).toHaveText(hint);
    await expect(card.locator("[data-caption-zone]")).toHaveCount(0);
    await position.getByRole("radio", { name: "Tengah" }).check();
    await expect(card.locator("[data-hook-near]")).toHaveCount(0);
    await position.getByRole("radio", { name: "Bawah" }).check();
    await expect(card.locator("[data-hook-near]")).toHaveCount(0);
    await planFollows(page);
    await expect(card.locator('[data-caption-zone="note"]')).toBeVisible();
    await position.getByRole("radio", { name: "Atas" }).check();
    await expect(card.locator("[data-hook-near]")).toHaveText(hint);
    // A hint, not a check: the plan carries no warning for it.
    const plan = await planFollows(page);
    expect(plan.warnings).toEqual([]);

    // The same document in Mode Lengkap: the same hint under the position slider.
    await toLengkap(page, "Teks");
    const panel = page.locator('[data-panel="text"]');
    await expect(panel.locator("[data-hook-near]")).toHaveText(hint);
    await expect(panel.getByRole("slider", { name: "Posisi caption" })).toHaveValue("38000");
    // The panel's slider drag merges per key; the card's pick did not.
    await panel.getByRole("slider", { name: "Posisi caption" }).focus();
    await page.keyboard.press("ArrowRight");
    expect(await lastSent(page)).toEqual({ type: "SetCaptionOverride", args: { key: "y_e5", value: 38500 }, mergeKey: "cap:y_e5" });
    const picks = (await sent(page)).filter((entry) => entry.type === "SetCaptionOverride" && entry.args.key === "y_e5");
    expect(picks.slice(0, 4).map((entry) => [entry.args.value, entry.mergeKey])).toEqual([[38000, null], [60000, null], [83000, null], [38000, null]]);
    // With the hook off the hint leaves, in the panel as in the card.
    await panel.getByRole("switch", { name: "Tampilkan hook" }).click();
    await expect(panel.locator("[data-hook-near]")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("Hook card: the text field, its counter and fit, the switch, and a suggestion as one undo step", async ({ page }) => {
    const errors = await openQuick(page, { ai: { answer: { taskId: null, heuristic: INSTANT, llm: { state: "disabled" } } } });
    const card = await openCard(page, "hook");
    const field = card.getByRole("textbox", { name: "Teks di awal klip" });
    await expect(field).toHaveValue("Kenapa sutradara ditahan di film sendiri?");
    await expect(card.locator("[data-hook-counter]")).toHaveText("41/90");
    await expect(card.locator("[data-hook-fit]")).toHaveText("Muat");
    await field.fill("Dia ditahan security ");
    expect(await lastSent(page)).toEqual({ type: "SetHookText", args: { text: "Dia ditahan security", origin: "user" }, mergeKey: "hook:text" });
    await expect(card.locator("[data-hook-counter]")).toHaveText("20/90");
    await expect(header(page, "hook")).toContainText("Dia ditahan security");
    const plan = await planFollows(page);
    expect(plan.hook.lines).toEqual(["Dia ditahan security"]);

    const list = card.getByRole("list", { name: "Saran otomatis" });
    const second = list.getByRole("button", { name: /Sutradara ditahan di film sendiri/ });
    await expect(second).toHaveAttribute("aria-pressed", "false");
    await expect(list.getByRole("button", { name: /depan pintu masuk belakang/ })).toContainText("Akan terpotong");
    await second.click();
    expect(await lastSent(page)).toEqual({ type: "SetHookText", args: { text: INSTANT_FAKE_SECOND, origin: "suggestion:hk_2" }, mergeKey: null });
    await expect(second).toHaveAttribute("aria-pressed", "true");
    await expect(field).toHaveValue(INSTANT_FAKE_SECOND);
    await page.getByRole("button", { name: "Urungkan" }).click();
    await expect(field).toHaveValue("Dia ditahan security");
    await expect(second).toHaveAttribute("aria-pressed", "false");

    await card.getByRole("switch", { name: "Tampilkan hook" }).click();
    expect(await lastSent(page)).toEqual({ type: "SetHookEnabled", args: { on: false }, mergeKey: null });
    await expect(field).toBeDisabled();
    await expect(header(page, "hook")).toContainText("Mati");
    await card.getByRole("switch", { name: "Tampilkan hook" }).click();
    expect(await lastSent(page)).toEqual({ type: "SetHookEnabled", args: { on: true, text: "Dia ditahan security" }, mergeKey: null });
    expect(errors).toEqual([]);
  });

  const AI_STATES = [
    { name: "pending, then done: the AI list arrives under its label; the privacy line shows",
      ai: { answer: { taskId: TASK_ID, heuristic: INSTANT, llm: { state: "pending" } }, pendingPolls: 1, task: { state: "done", suggestions: AI, error: null } },
      check: async (card) => {
        await expect(card.locator('[data-ai-status="pending"]')).toContainText("AI sedang menulis saran dari transkrip klip ini");
        await expect(card.locator("[data-ai-privacy]")).toBeVisible();
        await expect(card.getByRole("list", { name: "Saran AI" }).getByRole("button")).toHaveCount(1, { timeout: 10_000 });
        await expect(card.locator("[data-ai-privacy]")).toHaveText("Teks transkrip klip ini dikirim ke penyedia AI yang aktif di Pengaturan. Layanan gratis bisa memakai data yang dikirim.");
      } },
    { name: "a failed AI task says so, keeps the instant list, and Coba lagi asks again",
      ai: { answer: { taskId: TASK_ID, heuristic: INSTANT, llm: { state: "pending" } }, pendingPolls: 1,
        task: { state: "failed", suggestions: [], error: { code: "llm_unavailable" } } },
      check: async (card, page) => {
        await expect(card.locator("[data-ai-notice]")).toHaveText("Saran AI belum tersedia (kuota/koneksi); memakai saran otomatis.", { timeout: 10_000 });
        await expect(card.locator("[data-ai-privacy]")).toBeVisible();
        await expect(card.getByRole("list", { name: "Saran otomatis" }).getByRole("button")).toHaveCount(3);
        await card.getByRole("button", { name: "Coba lagi" }).click();
        await expect.poll(() => apiCalls(page, "aiHooks")).toBe(2);
      } },
    { name: "the hourly limit is explained, with the privacy line",
      ai: { answer: { taskId: null, heuristic: INSTANT, llm: { state: "rate_limited", retryAfterMs: 125_000 } } },
      check: async (card) => {
        await expect(card.locator("[data-ai-notice]")).toHaveText("Batas saran AI untuk proyek ini sudah tercapai (30 per jam). Coba lagi dalam 3 menit.");
        await expect(card.locator("[data-ai-privacy]")).toBeVisible();
      } },
    { name: "an AI answer with nothing usable says so",
      ai: { answer: { taskId: TASK_ID, heuristic: INSTANT, llm: { state: "pending" } }, pendingPolls: 1, task: { state: "done", suggestions: [], error: null } },
      check: async (card) => {
        await expect(card.locator("[data-ai-notice]")).toHaveText("AI belum menemukan hook yang sesuai isi klip ini. Pakai saran otomatis atau tulis sendiri.", { timeout: 10_000 });
        await expect(card.locator("[data-ai-privacy]")).toBeVisible();
      } },
    { name: "the settings notice replaces the AI part, without the privacy line",
      ai: { answer: { taskId: null, heuristic: INSTANT, llm: { state: "disabled", message: "Pengaturan AI tidak bisa dibaca; saran AI dimatikan dan saran otomatis dipakai." } } },
      check: async (card) => {
        await expect(card.locator("[data-ai-notice]")).toHaveText("Pengaturan AI tidak bisa dibaca; saran AI dimatikan dan saran otomatis dipakai.");
        await expect(card.locator("[data-ai-privacy]")).toHaveCount(0);
      } },
    { name: "a failed first request offers Coba lagi; then the list loads",
      ai: { failFirst: true, answer: { taskId: null, heuristic: INSTANT, llm: { state: "disabled" } } },
      check: async (card) => {
        await expect(card.getByRole("alert")).toHaveText("Saran hook belum bisa dimuat.");
        await card.getByRole("button", { name: "Coba lagi" }).click();
        await expect(card.getByRole("list", { name: "Saran otomatis" }).getByRole("button")).toHaveCount(3);
        await expect(card.locator("[data-ai-status]")).toHaveCount(0);
      } },
    { name: "a clip edited since the suggestions were made offers Perbarui saran",
      ai: { answer: { taskId: null, heuristic: INSTANT, llm: { state: "disabled" } } },
      check: async (card, page) => {
        await expect(card.getByRole("list", { name: "Saran otomatis" }).getByRole("button")).toHaveCount(3);
        await page.evaluate(() => window.__harness.store.dispatch("EditWordText", { wordId: "w048121", text: "Mengapa" }));
        await expect(card.getByText("Klip sudah diubah sejak saran ini dibuat.")).toBeVisible();
        await card.getByRole("button", { name: "Perbarui saran" }).click();
        await expect.poll(() => apiCalls(page, "aiHooks")).toBe(2);
        await expect(card.getByText("Klip sudah diubah sejak saran ini dibuat.")).toHaveCount(0);
      } },
  ];
  for (const entry of AI_STATES) {
    test(`AC17 Hook card: ${entry.name}`, async ({ page }) => {
      const errors = await openQuick(page, { ai: entry.ai });
      const card = await openCard(page, "hook");
      await entry.check(card, page);
      expect(errors).toEqual([]);
    });
  }

  test("U3 and the Cold open card: Pilih kalimat, Putar, Pakai; the Transisi section as in Lengkap; Hapus", async ({ page }) => {
    const started = Date.now();
    const steps = [];
    const mark = (step) => steps.push({ step, ms: Date.now() - started });
    const errors = await openQuick(page, { coldOpen: CANDIDATES });
    mark("editor ready");
    await expect(header(page, "coldopen")).toContainText("Mati");
    const card = await openCard(page, "coldopen");
    mark("Cold open card");
    await expect(card.getByText("Belum ada cold open.")).toBeVisible();
    expect(await apiCalls(page, "coldOpenSuggestions")).toBe(1);
    const choose = card.getByRole("button", { name: "Pilih kalimat" });
    await expect(choose).toHaveAttribute("aria-expanded", "false");
    await choose.click();
    await expect(choose).toHaveAttribute("aria-expanded", "true");
    const item = card.locator('[data-coldopen-suggestion="co_2"]');
    await item.getByRole("button", { name: "Putar saran 1" }).click();
    mark("Putar");
    await item.getByRole("button", { name: "Pakai saran 1 sebagai cold open" }).click();
    expect(await lastSent(page)).toEqual({ type: "SetColdOpen", args: { firstWord: "w048127", lastWord: "w048132" }, mergeKey: null });
    await expect(card.locator("[data-coldopen-line]")).toHaveText("“Jadi waktu itu kita datang subuh”");
    mark("Pakai: the quote shows");
    const elapsed = Date.now() - started;
    await expect(card.locator("[data-coldopen-length]")).toHaveText(/^\d+,\d dtk$/);
    await expect(card.getByText(/· diputar paling awal/)).toBeVisible();
    await expect(header(page, "coldopen")).toContainText("Kilat putih + whoosh");
    await expect(card.getByRole("button", { name: "Ganti kalimat" })).toBeVisible();
    let plan = await planFollows(page);
    expect(plan.pieces[0].role).toBe("cold_open");
    writeGate("B-U3.json", { gate: "QG-UX U3 (cold open in Mode Cepat, scripted on the harness)", limit_ms: LIMITS_MS.U3, elapsed_ms: elapsed,
      steps, viewport: page.viewportSize(), browser: page.context().browser()?.version() ?? null,
      note: "harness page: EditorApp on the real store and commands, fake API; automation speed, the owner times U3", pass: elapsed <= LIMITS_MS.U3 });
    expect(elapsed).toBeLessThanOrEqual(LIMITS_MS.U3);

    // Transisi: T3's section, the same controls and commands as in the panel.
    const section = card.locator("[data-coldopen-transition]");
    await expect(section.getByRole("heading", { name: "Transisi" })).toBeVisible();
    await expect(section.getByRole("group", { name: "Efek gambar" })).toBeVisible();
    await section.getByRole("radio", { name: /Gelap sebentar/ }).check();
    expect(await lastSent(page)).toEqual({ type: "SetJoinStyle", args: { style: "dip_black" }, mergeKey: null });
    await section.getByRole("switch", { name: "Suara whoosh" }).click();
    expect(await lastSent(page)).toEqual({ type: "SetJoinSfx", args: { on: false }, mergeKey: null });
    await expect(header(page, "coldopen")).toContainText("Gelap sebentar");
    await expect(section.locator("[data-transition-status]")).toHaveText("Whoosh mati.");
    plan = await planFollows(page);
    expect(plan.joins.map((join) => [join.style, join.sfx])).toEqual([["dip_black", null]]);
    await expect(section.getByRole("button", { name: "Putar transisi" })).toBeEnabled();

    await card.getByRole("button", { name: "Hapus cold open" }).click();
    expect(await lastSent(page)).toEqual({ type: "SetColdOpen", args: null, mergeKey: null });
    await expect(card.getByText("Belum ada cold open.")).toBeVisible();
    await expect(header(page, "coldopen")).toContainText("Mati");
    await expect(section.locator("[data-transition-note]")).toHaveText("Aktifkan cold open dulu.");
    expect(errors).toEqual([]);
  });

  test("Cold open card with a cold open: Putar plays it from the start; read-only still plays", async ({ page }) => {
    const errors = await openQuick(page, { harness: { doc: COLD, readOnly: true }, coldOpen: CANDIDATES });
    const card = await openCard(page, "coldopen");
    await expect(card.locator("[data-coldopen-line]")).toHaveText("“Jadi waktu itu kita datang subuh”");
    const play = card.getByRole("button", { name: "Putar cold open" });
    await expect(play).toBeEnabled();
    await page.evaluate(() => window.__potonginEditor.player.seek(90));
    await play.click();
    await expect.poll(() => page.evaluate(() => window.__potonginEditor.player.frame())).toBe(0);
    await expect(card.locator("[data-coldopen-transition]").getByRole("button", { name: "Putar transisi" })).toBeEnabled();
    await expect(card.locator("[data-coldopen-transition]").getByRole("radio", { name: /Kilat putih/ })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Hapus cold open" })).toBeDisabled();
    expect(await sent(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("Tata letak card: Potong tengah switches at once; the plan follows", async ({ page }) => {
    const errors = await openQuick(page);
    const card = await openCard(page, "layout");
    const group = card.getByRole("group", { name: "Pilih tata letak" });
    await expect(group.locator("label")).toHaveText(["Latar blur", "Potong tengah", "Ikuti wajah"]);
    await expect(group.getByRole("radio", { name: "Latar blur" })).toBeChecked();
    await group.getByRole("radio", { name: "Potong tengah" }).check();
    expect(await lastSent(page)).toEqual({ type: "SetLayout", args: { mode: "fill_center" }, mergeKey: null });
    await expect(header(page, "layout")).toContainText("Potong tengah");
    const plan = await planFollows(page);
    expect(plan.plate.plateKey).toBe(fakeSha256("plate:fill_center"));
    expect(errors).toEqual([]);
  });

  test("AC16: a face analysis started in the card outlives the card and the view, shows in LayoutPanel and applies once", async ({ page }) => {
    const errors = await openQuick(page, { prepareMs: 4000 });
    const card = await openCard(page, "layout");
    await card.getByRole("radio", { name: "Ikuti wajah" }).check();
    const analysis = card.locator("[data-layout-analysis]");
    await expect(analysis.locator("[data-layout-analysis-text]")).toHaveText(/^Menganalisis wajah… \d+%$/);
    await expect(card.getByRole("radio", { name: "Ikuti wajah" })).toBeChecked();
    await expect(header(page, "layout")).toContainText("Latar blur · menganalisis…");
    expect((await docOf(page)).layout.default.mode).toBe("fit_blur");
    await header(page, "layout").click(); // the card closes; the run goes on
    await expect(card).toHaveAttribute("inert", "");
    await toLengkap(page, "Tata letak");
    const panel = page.locator('[data-panel="layout"]');
    await expect(panel.locator("[data-layout-analysis]")).toBeVisible();
    await expect(panel.locator('[data-layout-card-progress="camera"]')).toBeVisible();
    await expect.poll(async () => (await docOf(page)).layout.default.mode, { timeout: 15_000 }).toBe("camera");
    await expect(panel.locator("[data-layout-analysis]")).toBeHidden();
    const layouts = (await sent(page)).filter((entry) => entry.type === "SetLayout");
    expect(layouts).toEqual([{ type: "SetLayout", args: { mode: "camera" }, mergeKey: null }]);
    expect(await apiCalls(page, "prepare")).toBe(1);
    writeGate("B-AC16-layout.json", { gate: "AC16 (face analysis outlives the card and the view)", setLayout: layouts.length, prepare: 1, pass: true });
    expect(errors).toEqual([]);
  });

  test("Logo & Musik card: add and remove a logo; music with the notice once, its strength and Hapus", async ({ page }) => {
    const errors = await openQuick(page);
    const card = await openCard(page, "extras");
    await expect(header(page, "extras")).toContainText("Belum ada");
    const logo = card.locator('[data-extras="logo"]');
    let chooser = page.waitForEvent("filechooser");
    await logo.getByRole("button", { name: "Tambah logo" }).click();
    await (await chooser).setFiles(LOGO);
    await expect(logo.getByRole("button", { name: "Hapus logo" })).toBeVisible({ timeout: 10_000 });
    expect((await lastSent(page)).type).toBe("SetLogo");
    await expect(header(page, "extras")).toContainText("Logo");
    await expect(page.locator("[data-logo-box]")).toBeVisible(); // placed by dragging it on the preview

    const music = card.locator('[data-extras="music"]');
    chooser = page.waitForEvent("filechooser");
    await music.getByRole("button", { name: "Tambah musik" }).click();
    await expect(music.getByText(/oleh pemeriksaan hak cipta di TikTok, Instagram dan YouTube \(Content ID\)\./)).toBeVisible();
    await music.getByRole("button", { name: "Pilih file musik" }).click();
    await (await chooser).setFiles(MUSIC);
    await expect(music.locator("[data-music-name]")).toHaveText(MUSIC.name, { timeout: 10_000 });
    expect((await lastSent(page))).toMatchObject({ type: "SetMusic", mergeKey: null });
    await expect(header(page, "extras")).toContainText("Logo dan musik");
    const strength = music.getByRole("group", { name: "Saat ada suara" });
    await expect(strength.getByRole("radio", { name: "Sedang" })).toBeChecked();
    await strength.getByRole("radio", { name: "Kuat" }).check();
    expect(await lastSent(page)).toEqual({ type: "SetDuck", args: { preset: "kuat" }, mergeKey: "music:duck" });

    await music.getByRole("button", { name: "Hapus musik" }).click();
    expect(await lastSent(page)).toEqual({ type: "RemoveMusic", args: {}, mergeKey: null });
    await logo.getByRole("button", { name: "Hapus logo" }).click();
    expect(await lastSent(page)).toEqual({ type: "RemoveLogo", args: {}, mergeKey: null });
    await expect(header(page, "extras")).toContainText("Belum ada");
    // The copyright notice is shown once: the next "Tambah musik" opens the file picker at once.
    chooser = page.waitForEvent("filechooser");
    await music.getByRole("button", { name: "Tambah musik" }).click();
    await chooser;
    await expect(music.getByRole("button", { name: "Pilih file musik" })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test("AC16: a music upload started in the card finishes and applies after the view switches", async ({ page }) => {
    const errors = await openQuick(page, { musicStepMs: 900 });
    await page.evaluate(() => { try { localStorage.setItem("potongin-editor-music-notice", "1"); } catch { /* private mode */ } });
    const card = await openCard(page, "extras");
    const music = card.locator('[data-extras="music"]');
    const chooser = page.waitForEvent("filechooser");
    await music.getByRole("button", { name: "Tambah musik" }).click();
    await (await chooser).setFiles(MUSIC);
    await expect(music.getByRole("progressbar", { name: `Mengunggah ${MUSIC.name}` })).toBeVisible();
    await music.getByRole("button", { name: "Atur detail di Mode Lengkap" }).click();
    await expect(page.locator("[data-editor-root]")).toHaveAttribute("data-editor-view", "lengkap");
    const panel = page.locator('[data-panel="music"]');
    await expect(panel.getByRole("progressbar", { name: `Mengunggah ${MUSIC.name}` })).toBeVisible();
    await expect(panel.locator("[data-music-name]")).toHaveText(MUSIC.name, { timeout: 15_000 });
    const musics = (await sent(page)).filter((entry) => entry.type === "SetMusic");
    expect(musics).toHaveLength(1);
    expect(await page.evaluate(() => window.__quick.musicUploads.length)).toBe(1);
    writeGate("B-AC16-music.json", { gate: "AC16 (music upload outlives the card and the view)", setMusic: musics.length, uploads: 1, pass: true });
    expect(errors).toEqual([]);
  });

  test("U4: a hook suggestion and a pack in Mode Cepat within 30 s", async ({ page }) => {
    const started = Date.now();
    const steps = [];
    const mark = (step) => steps.push({ step, ms: Date.now() - started });
    const errors = await openQuick(page);
    mark("editor ready");
    const hook = await openCard(page, "hook");
    await hook.getByRole("button", { name: /Sutradara ditahan di film sendiri/ }).click();
    mark("hook suggestion");
    const caption = await openCard(page, "caption");
    await caption.getByRole("group", { name: "Gaya caption" }).getByRole("radio", { name: "Bold" }).check();
    mark("pack Bold");
    await planFollows(page);
    mark("preview current");
    const elapsed = Date.now() - started;
    const doc = await docOf(page);
    expect(doc.captions.pack.id).toBe("bold");
    expect(doc.tracks.find((track) => track.kind === "hook").items[0].payload.text).toBe(INSTANT_FAKE_SECOND);
    writeGate("B-U4.json", { gate: "QG-UX U4 (hook and pack in Mode Cepat, scripted on the harness)", limit_ms: LIMITS_MS.U4, elapsed_ms: elapsed,
      steps, viewport: page.viewportSize(), browser: page.context().browser()?.version() ?? null,
      note: "harness page: EditorApp on the real store and commands, fake API; automation speed, the owner times U4", pass: elapsed <= LIMITS_MS.U4 });
    expect(elapsed).toBeLessThanOrEqual(LIMITS_MS.U4);
    expect(errors).toEqual([]);
  });

  test("U5: logo and ducked music in Mode Cepat within 60 s; it stops when the music lane shows the lowered line", async ({ page }) => {
    const started = Date.now();
    const steps = [];
    const mark = (step) => steps.push({ step, ms: Date.now() - started });
    const errors = await openQuick(page);
    mark("editor ready");
    const card = await openCard(page, "extras");
    let chooser = page.waitForEvent("filechooser");
    await card.getByRole("button", { name: "Tambah logo" }).click();
    await (await chooser).setFiles(LOGO);
    await expect(card.getByRole("button", { name: "Hapus logo" })).toBeVisible({ timeout: 10_000 });
    mark("logo added");
    chooser = page.waitForEvent("filechooser");
    await card.getByRole("button", { name: "Tambah musik" }).click();
    await card.getByRole("button", { name: "Pilih file musik" }).click();
    await (await chooser).setFiles(MUSIC);
    await expect(card.locator("[data-music-name]")).toHaveText(MUSIC.name, { timeout: 10_000 });
    mark("music added");
    await card.getByRole("group", { name: "Saat ada suara" }).getByRole("radio", { name: "Kuat" }).check();
    mark("strength Kuat");
    // The stop condition is unchanged (§11 Q5): the music lane in Lengkap shows the lowered line.
    await card.locator('[data-extras="music"]').getByRole("button", { name: "Atur detail di Mode Lengkap" }).click();
    const lane = page.locator('[data-lane="music"]');
    await expect(lane.getByRole("img", { name: "Volume musik sepanjang klip: turun saat ada suara" })).toBeVisible({ timeout: 10_000 });
    await expect(lane.locator("[data-music-envelope]")).toBeVisible();
    mark("music lane shows the lowered line");
    const elapsed = Date.now() - started;
    const payload = (await docOf(page)).tracks.find((track) => track.kind === "audio").items[0].payload;
    expect(payload.duck).toMatchObject({ on: true, depth_cdb: 1600 });
    writeGate("B-U5.json", { gate: "QG-UX U5 (logo and ducked music in Mode Cepat, scripted on the harness)", limit_ms: LIMITS_MS.U5,
      elapsed_ms: elapsed, steps, viewport: page.viewportSize(), browser: page.context().browser()?.version() ?? null,
      stop_condition: "lajur Musik di timeline menunjukkan garis volume yang turun (unchanged, §11 Q5)",
      note: "harness page: EditorApp on the real store and commands, fake API and upload clients; the envelope is the init script's stand-in for the server's; automation speed, the owner times U5",
      pass: elapsed <= LIMITS_MS.U5 });
    expect(elapsed).toBeLessThanOrEqual(LIMITS_MS.U5);
    expect(errors).toEqual([]);
  });

  test("read-only: every editing control of the cards is disabled; playing still works", async ({ page }) => {
    const errors = await openQuick(page, { harness: { readOnly: true } });
    const caption = region(page, "caption");
    await expect(caption.getByRole("switch", { name: "Tampilkan caption" })).toBeDisabled();
    for (const radio of await caption.getByRole("radio").all()) await expect(radio).toBeDisabled();
    const hook = await openCard(page, "hook");
    await expect(hook.getByRole("textbox", { name: "Teks di awal klip" })).toBeDisabled();
    await expect(hook.getByRole("switch", { name: "Tampilkan hook" })).toBeDisabled();
    await expect(hook.getByRole("list", { name: "Saran otomatis" }).getByRole("button").first()).toBeDisabled();
    const layout = await openCard(page, "layout");
    for (const radio of await layout.getByRole("radio").all()) await expect(radio).toBeDisabled();
    const extras = await openCard(page, "extras");
    await expect(extras.getByRole("button", { name: "Tambah logo" })).toBeDisabled();
    await expect(extras.getByRole("button", { name: "Tambah musik" })).toBeDisabled();
    expect(await sent(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  for (const viewport of [{ width: 1366, height: 650 }, { width: 1920, height: 960 }]) {
    const size = `${viewport.width}x${viewport.height}`;
    test(`AC13 at ${size}: every card control is at least 44 px, one card open, axe finds nothing serious`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const errors = await openQuick(page, { coldOpen: CANDIDATES });
      if (AXE) await page.addScriptTag({ content: AXE });
      const small = [];
      const axe = {};
      for (const id of CARD_IDS) {
        if (id === "lines") continue; // task C's card
        const body = await openCard(page, id);
        await expect(body).toBeVisible();
        if (id === "coldopen") await body.getByRole("button", { name: "Pilih kalimat" }).click();
        if (id === "hook") await expect(body.getByRole("list", { name: "Saran otomatis" }).getByRole("button")).toHaveCount(2);
        if (id === "coldopen") await expect(body.locator("[data-coldopen-suggestion]")).toHaveCount(1);
        await expect(page.locator('[data-slot="cards"] [aria-expanded="true"]')).toHaveCount(1);
        const found = await body.evaluate((root) => {
          const out = [];
          const controls = root.querySelectorAll("button, input, textarea, select, [role='switch']");
          for (const control of controls) {
            if (control.type === "file" || control.closest("[hidden]") || control.closest("[inert]")) continue;
            // A radio or checkbox drawn by its label is as large as that label (the hit area).
            const target = ["radio", "checkbox"].includes(control.type) ? control.closest("label") ?? control : control;
            const box = target.getBoundingClientRect();
            if (box.width === 0 && box.height === 0) continue;
            if (box.height < 43.5 || box.width < 43.5) {
              out.push({ name: control.getAttribute("aria-label") || target.textContent.trim().slice(0, 40), w: Math.round(box.width), h: Math.round(box.height) });
            }
          }
          return { count: controls.length, small: out };
        });
        small.push(...found.small.map((entry) => ({ card: id, ...entry })));
        if (AXE) {
          const result = await page.evaluate(async (selector) => window.axe.run(selector, { resultTypes: ["violations"] }), `#card-${id}-region`);
          axe[id] = result.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length }));
        }
        // The side column scrolls inside itself; nothing in a card runs sideways.
        const overflow = await body.evaluate((element) => element.scrollWidth - element.clientWidth);
        expect(overflow, id).toBeLessThanOrEqual(0);
      }
      const serious = Object.values(axe).flat().filter((violation) => ["critical", "serious"].includes(violation.impact));
      writeGate(`B-AC13-${size}.json`, { gate: "AC13 for the cards (44 px targets, axe)", viewport, small, axe: AXE ? axe : "AXE_CORE_PATH not set",
        pass: small.length === 0 && serious.length === 0 });
      expect(small).toEqual([]);
      expect(serious).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("AC13: under forced colours a focused pill, swatch and card header keep a visible outline", async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active" });
    const errors = await openQuick(page);
    const outlineOf = (locator) => locator.evaluate((element) => {
      const style = getComputedStyle(element);
      return { style: style.outlineStyle, width: style.outlineWidth };
    });
    const card = region(page, "caption");
    await header(page, "caption").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(header(page, "caption")).toBeFocused();
    expect((await outlineOf(header(page, "caption"))).style).not.toBe("none");
    const pill = card.getByRole("group", { name: "Ukuran" }).getByRole("radio", { name: "Sedang" });
    await pill.focus();
    await page.keyboard.press("ArrowRight");
    await expect(card.getByRole("group", { name: "Ukuran" }).getByRole("radio", { name: "Besar" })).toBeFocused();
    const label = card.getByRole("group", { name: "Ukuran" }).locator("label").filter({ hasText: "Besar" });
    expect((await outlineOf(label)).style).not.toBe("none");
    expect(await lastSent(page)).toEqual({ type: "SetCaptionOverride", args: { key: "size_pm", value: 1200 }, mergeKey: null });
    expect(errors).toEqual([]);
  });
});

// --- the Next fakes (app CSS, reduced motion, lime) -----------------------------------------------------

test.describe("Mode Cepat cards on the editor fakes (Next server)", () => {
  test.skip(process.env.E2E_EDITOR_FAKES !== "1",
    "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
  test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");
  test.use({ baseURL: settings.baseURL });

  async function openServer(page) {
    await login(page, "/projects");
    await page.goto(SERVER_CEPAT_URL);
    await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  }

  test("reduced motion: the accordion does not animate; no request to the AI route on load", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openServer(page);
    const durations = await page.locator("#card-caption-region").evaluate((element) => getComputedStyle(element).transitionDuration);
    const ms = (value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000);
    expect(durations.split(",").every((value) => ms(value) < 1), durations).toBe(true);
    expect(await page.evaluate(() => window.__potonginEditor.api.calls.filter((call) => call.name === "aiHooks").length)).toBe(0);
  });

  test("AC12 for the cards: lime appears on no card control, open or hovered", async ({ page }) => {
    await openServer(page);
    const LIME = ["rgb(223, 255, 88)", "rgb(236, 255, 154)"];
    const limed = [];
    for (const id of CARD_IDS) {
      const body = await openCard(page, id);
      await expect(body).toBeVisible();
      for (const control of await body.locator("button:visible, label:visible").all()) {
        await control.hover().catch(() => {});
        const colours = await control.evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.color, style.backgroundColor, style.borderTopColor, style.outlineColor];
        });
        if (colours.some((colour) => LIME.includes(colour))) limed.push({ card: id, text: (await control.textContent())?.trim().slice(0, 40) });
      }
    }
    expect(limed).toEqual([]);
  });
});
