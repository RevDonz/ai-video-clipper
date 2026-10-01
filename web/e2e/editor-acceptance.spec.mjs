// Editor acceptance (plan §11.4 T4.5): one test per Essentials capability of plan §1.1 (13 in
// total), each driving the real editor the way the owner does, on the real stack: a production
// build with POTONGIN_EDITOR_V3, POTONGIN_EDITOR_UPLOADS (and optionally POTONGIN_EDITOR_LLM) on,
// the render worker, and a JOBS_ROOT holding COPIES of real jobs. Plus QG-A11Y (plan §10.2): axe
// finds no critical or serious violation in any panel or dialog at 1366×768 and 1920×1080, and every
// control of every panel is reachable by keyboard with a visible focus ring.
//
//   1 Buka klip                    5 Caption + 4 gaya             9 Musik + ducking
//   2 Trim menempel ke kata        6 Potong lewat transkrip       10 Waveform + penanda
//   3 Cold open                    7 Tata letak                   11 Delapan bug editor lama
//   4 Hook + saran AI              8 Logo                         12 Urungkan, simpan otomatis, konflik
//                                                                 13 Ekspor lewat antrean
//
// Every test starts from the AI version of its clip and leaves the clip there. The checks are the
// observable outcomes of §1.1 (and §8 for capability 11): what the screen shows, what the saved
// document holds, what the exported file contains. Time limits and thresholds are the plan's.
//
// Setup (every value is required unless marked optional):
//   E2E_BASE_URL, E2E_USERNAME, E2E_PASSWORD   a private server (never the owner's :3000/:3001)
//   E2E_EDITOR_JOB_ID                          a V3 job in that server's JOBS_ROOT (a copy)
//   E2E_JOBS_ROOT                              that JOBS_ROOT (exports and receipts are read there)
//   E2E_ACCEPT_CLOSED_JOB_ID                   a job in that JOBS_ROOT whose clips cannot be opened
//                                              (for example a copy of a job without its source video)
//   E2E_EDITOR_PYTHON (optional)               a Python with ai_clipper (default: python3)
//   E2E_EDITOR_LLM=1 (optional)                the server runs with POTONGIN_EDITOR_LLM=on
//   AXE_CORE_PATH                              axe.min.js (axe-core is not a web dependency)
//   EDITOR_GATES_OUT (optional)                where the evidence JSON is written (numbers only)
// The server must run with POTONGIN_EDITOR_UPLOADS=on. FFmpeg and ffprobe must be on PATH. The
// browser is Chrome for Testing 147.0.7727.15 (Playwright build 1217) when installed; PARITY_CHROME
// overrides it. Run (one browser, one worker):
//   E2E_NO_WEB_SERVER=1 npx playwright test e2e/editor-acceptance.spec.mjs --project=desktop-chromium
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

import { login, settings } from "./support/harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const JOB_ID = process.env.E2E_EDITOR_JOB_ID || "";
const JOBS_ROOT = process.env.E2E_JOBS_ROOT || "";
const CLOSED_JOB_ID = process.env.E2E_ACCEPT_CLOSED_JOB_ID || "";
const PYTHON = process.env.E2E_EDITOR_PYTHON || "python3";
const GATES_OUT = process.env.EDITOR_GATES_OUT || "";
const LLM = process.env.E2E_EDITOR_LLM === "1";
const AXE = process.env.AXE_CORE_PATH && existsSync(process.env.AXE_CORE_PATH) ? readFileSync(process.env.AXE_CORE_PATH, "utf8") : null;

// Plan numbers (never weakened here): §1.1, §3.3, §4.5, §7, §10.2.
const COLD_OPEN_MIN_MS = 500;
const COLD_OPEN_MAX_MS = 8000;
const HOOK_MAX_CHARS = 90;
const UNDO_DEPTH = 200;
const RECEIPTS_KEEP = 200;
const AUTOSAVE_MS = 1500;
const LLM_DEADLINE_MS = 20_000;
const TRUE_PEAK_MAX_DBTP = -1.0;
const DUCK_DEPTH_CDB = { Halus: 600, Sedang: 1000, Kuat: 1600 };
const PARTICLES = new Set(["sih", "dong", "kok", "lho", "loh", "mah", "kan", "toh", "deh", "nah", "ya", "yah", "tuh", "nih", "kah", "pun", "lah"]);
const CLOSED_REASONS = new Set(["Video sumber sudah tidak ada", "Video sumber tidak bisa dibaca; proses ulang videonya",
  "Hasil seleksi tidak terbaca", "Transkrip tidak ditemukan", "Analisis job belum selesai",
  "Klip dari job ini tidak bisa diedit; proses ulang videonya"]);

function defaultChrome() {
  const candidate = path.join(os.homedir(), ".cache", "ms-playwright", "chromium-1217", "chrome-linux64", "chrome");
  return existsSync(candidate) ? candidate : undefined;
}
const chrome = process.env.PARITY_CHROME || defaultChrome();

test.use({
  launchOptions: { ...(chrome ? { executablePath: chrome } : {}), args: ["--autoplay-policy=no-user-gesture-required", "--mute-audio"] },
  viewport: { width: 1366, height: 768 },
  acceptDownloads: true,
});
test.describe.configure({ mode: "serial" });
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");
test.skip(!JOB_ID || !JOBS_ROOT, "E2E_EDITOR_JOB_ID and E2E_JOBS_ROOT name a copy of a real job on a private server");

// --- page and API helpers ------------------------------------------------------------------------

/** A same-origin API call made by the page (the session cookie is Secure): `{status, body, headers}`. */
async function api(page, method, url, json, headers = {}) {
  return page.evaluate(async ({ method: verb, url: target, json: body, headers: extra }) => {
    const init = { method: verb, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", ...extra } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    const response = await fetch(target, init);
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers.entries()) };
  }, { method, url, json, headers });
}

const evidence = {};
function writeEvidence(name, value) {
  evidence[name] = value;
  if (!GATES_OUT) return;
  mkdirSync(GATES_OUT, { recursive: true });
  writeFileSync(path.join(GATES_OUT, `${name}.json`), `${JSON.stringify({ schema: "potongin.gate/1", ...value }, null, 2)}\n`);
}

let clips = null; // [{clipId, index, durationMs, title}]

async function ensureClips(page) {
  if (clips?.length) return clips;
  const prepared = await api(page, "POST", `/api/jobs/${JOB_ID}/clips`, {});
  expect([200, 202, 429], `POST /clips: ${prepared.status} ${JSON.stringify(prepared.body)}`).toContain(prepared.status);
  await expect.poll(async () => {
    const listing = (await api(page, "GET", `/api/jobs/${JOB_ID}/clips`)).body;
    clips = (listing.clips ?? []).filter((clip) => clip.openable && clip.clipId);
    return clips.length;
  }, { timeout: 600_000 }).toBeGreaterThan(0);
  return clips;
}

/** The shortest openable clip (exports render it), and the longest (transcript work has room). */
const shortest = () => [...clips].sort((a, b) => a.durationMs - b.durationMs)[0];
const longest = () => [...clips].sort((a, b) => b.durationMs - a.durationMs)[0];

const editorUrl = (clipId) => `/projects/${JOB_ID}/clips/${clipId}/edit`;

const inspect = (page) => page.evaluate(() => {
  const hook = globalThis.__potonginEditorInspect;
  if (!hook) return null;
  const state = hook.state();
  const player = hook.player();
  return {
    status: state.status, save: state.save, etag: state.etag, revision: state.revision, pending: state.pending,
    commands: state.commands?.length ?? 0, doc: state.doc, seed: state.seed, plan: state.plan, canUndo: state.canUndo,
    canRedo: state.canRedo, otherTab: state.otherTab,
    player: player ? { mode: player.mode, frame: player.frame, exact: player.exact, presentedFrame: player.presentedFrame } : null,
  };
});

/** The clip's words artifact as the editor loaded it (words, bounds, events, missing). */
const wordsArtifact = (page) => page.evaluate(() => {
  const words = globalThis.__potonginEditorInspect.state().words;
  return { words: words.words, bounds: words.bounds, events: words.events ?? [], missing: words.missing ?? [], fps: words.fps };
});

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function contentOf(doc) {
  const { revision: _revision, parent_sha256: _parent, audit: _audit, ...rest } = doc;
  return canonical(rest);
}

async function openEditor(page, clipId) {
  const started = Date.now();
  await page.goto(editorUrl(clipId));
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 60_000 });
  return Date.now() - started;
}

async function waitSaved(page, timeout = 30_000) {
  await expect.poll(async () => {
    const state = await inspect(page);
    return state && state.save === "saved" && state.commands === 0;
  }, { timeout }).toBe(true);
  return inspect(page);
}

async function blur(page) {
  await page.evaluate(() => document.activeElement?.blur?.());
}

async function resetToSeed(page) {
  const state = await inspect(page);
  if (state.seed && contentOf(state.doc) === contentOf(state.seed)) return;
  await page.getByRole("button", { name: "Kembali ke versi AI" }).click();
  const reset = await waitSaved(page);
  expect(contentOf(reset.doc)).toBe(contentOf(reset.seed));
}

/** Opens a clip at its AI version, with the uncaught-error watch armed. */
async function start(page, clip) {
  await openEditor(page, clip.clipId);
  await resetToSeed(page);
}

const transcript = (page) => page.locator('[data-panel="transcript"]');
const toolbar = (page) => page.getByRole("toolbar", { name: "Aksi kata" });
const panelOf = (page, id) => page.locator(`[data-panel="${id}"]`);
const word = (page, index) => transcript(page).locator(`[data-w="${index}"]`);

async function openTab(page, name) {
  await page.getByRole("tab", { name, exact: true }).click();
  await expect(page.getByRole("tab", { name, exact: true })).toHaveAttribute("aria-selected", "true");
}

async function bodyWordIndexes(page) {
  await openTab(page, "Transkrip");
  return transcript(page).locator('[data-w][data-zone="body"]:not([data-removed])')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("data-w"))));
}

async function selectRange(page, first, last) {
  await word(page, first).scrollIntoViewIfNeeded();
  await word(page, first).click();
  if (last !== first) {
    await word(page, last).scrollIntoViewIfNeeded();
    await word(page, last).click({ modifiers: ["Shift"] });
  }
}

/** A run of consecutive body words whose span (first start to last end) lies in [minMs, maxMs]. */
function findRun(words, body, { minMs, maxMs, from = 2 }) {
  for (let i = from; i < body.length - 2; i += 1) {
    for (let j = i; j < body.length - 2; j += 1) {
      if (body[j] - body[i] !== j - i) break;
      const span = words[body[j]].e - words[body[i]].s;
      if (span >= minMs && span <= maxMs) return [body[i], body[j], span];
      if (span > maxMs) break;
    }
  }
  return null;
}

const bodyOf = (doc) => doc.main.segments.find((segment) => segment.role === "body");
const coldOf = (doc) => doc.main.segments.find((segment) => segment.role === "cold_open") ?? null;
const hookOf = (doc) => doc.tracks.find((track) => track.kind === "hook")?.items?.[0] ?? null;
const logoOf = (doc) => doc.tracks.find((track) => track.kind === "visual")?.items?.[0] ?? null;
const musicOf = (doc) => doc.tracks.find((track) => track.kind === "audio")?.items?.[0] ?? null;

// "● Sesuai hasil akhir"; a document whose content is the AI version's exports the auto file itself,
// which came before the editor (engine still legacy), so there the badge says so instead.
async function exactBadge(page, { timeout = 120_000, unchangedOk = false } = {}) {
  const state = await inspect(page);
  const unchanged = unchangedOk || (state?.seed && contentOf(state.doc) === contentOf(state.seed));
  const text = unchanged ? /^● (?:Sesuai hasil akhir|Belum diubah: ekspor = klip otomatis)$/ : "● Sesuai hasil akhir";
  await expect(page.getByTestId("stage-badge")).toHaveText(text, { timeout });
}

/** The ASS bytes of the current plan (the same bytes libass draws in the browser and FFmpeg burns). */
async function currentAss(page) {
  const state = await inspect(page);
  const url = state.plan?.text?.url;
  expect(url, "the plan names its ASS").toBeTruthy();
  const response = await api(page, "GET", url);
  expect(response.status).toBe(200);
  return String(response.body);
}

/** The plan once it reflects the saved document (no layer pending), with its ASS. */
async function settledPlan(page) {
  await expect.poll(async () => {
    const state = await inspect(page);
    return Boolean(state.plan) && !(state.pending ?? []).includes("text") && state.save === "saved" && state.commands === 0;
  }, { timeout: 30_000 }).toBe(true);
  return (await inspect(page)).plan;
}

// --- export helpers -------------------------------------------------------------------------------

/** Export through the dialog; resolves with the final RenderDTO, the dialog and the step order seen. */
async function exportClip(page, { timeout = 600_000 } = {}) {
  await blur(page);
  await page.getByRole("button", { name: "Ekspor", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Ekspor klip" });
  await expect(dialog).toBeVisible();
  for (const box of await dialog.getByRole("checkbox").all()) await box.check();
  const created = page.waitForResponse((response) => response.request().method() === "POST" && /\/renders$/.test(new URL(response.url()).pathname));
  const started = Date.now();
  await dialog.getByRole("button", { name: "Mulai ekspor" }).click();
  const createdResponse = await created;
  const first = await createdResponse.json();
  const steps = new Set();
  const link = dialog.getByRole("link", { name: "Unduh MP4" });
  const watch = (async () => {
    while (!(await link.isVisible().catch(() => false)) && Date.now() - started < timeout) {
      const current = await dialog.locator('[data-step-status="current"]').textContent().catch(() => null);
      if (current) steps.add(current.replace(/\s*\(\d+%\)$/, ""));
      await page.waitForTimeout(150);
    }
  })();
  await expect(link.or(dialog.getByRole("alert"))).toBeVisible({ timeout });
  await watch;
  if (!(await link.isVisible())) {
    throw new Error(`export failed: ${createdResponse.status()} ${JSON.stringify(first)}: ${await dialog.getByRole("alert").textContent()}`);
  }
  const doneMs = Date.now() - started;
  const polled = await api(page, "GET", `/api/jobs/${JOB_ID}/renders/${first.renderId}`);
  const final = polled.status === 200 ? polled.body : first;
  await expect(dialog.getByText(`Revisi ${final.revision} · tersimpan`)).toBeVisible();
  return { dialog, render: final, created: first, createdStatus: createdResponse.status(), doneMs, steps: [...steps] };
}

// Downloads and scratch files live in temporary folders removed after each test.
const scratch = [];
function scratchDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "editor-acceptance-"));
  scratch.push(dir);
  return dir;
}

async function download(page, dialog, name) {
  const waiting = page.waitForEvent("download");
  await dialog.getByRole("link", { name }).click();
  const file = await waiting;
  const target = path.join(scratchDir(), file.suggestedFilename());
  await file.saveAs(target);
  return target;
}

function jobFile(apiUrl) {
  const prefix = `/api/jobs/${JOB_ID}/files/`;
  expect(apiUrl.startsWith(prefix)).toBeTruthy();
  return path.join(JOBS_ROOT, JOB_ID, ...apiUrl.slice(prefix.length).split("?")[0].split("/").map(decodeURIComponent));
}

const CHILD_ENV = () => ({ PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" });

/** G1–G3 (and G3b) of a downloaded export against the document it was made from. */
function verifyExport(doc, file) {
  const docFile = path.join(path.dirname(file), "doc.json");
  writeFileSync(docFile, JSON.stringify(doc));
  let out;
  try {
    out = execFileSync(PYTHON, [path.join(repoRoot, "scripts", "editor", "verify_export.py"), "--job-dir", path.join(JOBS_ROOT, JOB_ID),
      "--doc", docFile, "--file", file], { encoding: "utf8", env: CHILD_ENV() });
  } catch (error) {
    out = error.stdout?.toString() ?? "{}";
  }
  return JSON.parse(out.trim().split("\n").at(-1));
}

/**
 * The blocking gates of a downloaded export (G1–G3, G3b), checked again here from its document.
 * Loudness is a constant gain (§5.6): when the clip's own peaks stop it short of the target, the
 * editor states the level reached ("loudness_clamped", shown as "Catatan audio") and G3 holds the
 * file to that level ± 0.5 LU, which only the render knew; this check then reads it from the plan.
 */
async function expectExportGates(page, dialog, doc, file) {
  const planWarnings = (await settledPlan(page)).warnings ?? [];
  const clampedAt = planWarnings.map((warning) => /^loudness_clamped:([+-]?\d+(?:\.\d+)?) LUFS$/.exec(warning.code)).find(Boolean);
  const verified = verifyExport(doc, file);
  const gates = verified.report?.gates ?? [];
  const failing = gates.filter((gate) => gate.blocking && !gate.ok);
  if (clampedAt && failing.length === 1 && failing[0].name === "G3" && failing[0].problems.join() === "integrated_loudness") {
    await expect(dialog.getByText(/^Catatan audio: Target kenyaringan tidak tercapai tanpa pecah/)).toBeVisible();
    expect(Math.abs(failing[0].values.i_clufs / 100 - Number(clampedAt[1])), "loudness at the stated clamp ± 0.5 LU").toBeLessThanOrEqual(0.5);
    return { ...verified, clampedAt: Number(clampedAt[1]) };
  }
  expect(verified.ok, `${JSON.stringify(gates)} warnings ${JSON.stringify(planWarnings)}`).toBe(true);
  return verified;
}

function probe(file, entries, stream = "a:0") {
  return execFileSync("ffprobe", ["-v", "error", "-select_streams", stream, "-show_entries", entries, "-of", "json", file],
    { encoding: "utf8", env: CHILD_ENV() });
}

/** Mean RGB of a w×h block of the frame at `seconds` in a video file. */
function meanRgb(file, seconds, { x, y, w, h }) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-ss", String(seconds), "-i", file, "-frames:v", "1",
    "-vf", `crop=${w}:${h}:${x}:${y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { env: CHILD_ENV(), maxBuffer: 1 << 24 });
  const sum = [0, 0, 0];
  for (let i = 0; i < raw.length; i += 3) for (let c = 0; c < 3; c += 1) sum[c] += raw[i + c];
  const count = raw.length / 3;
  return sum.map((value) => Math.round(value / count));
}

// --- synthetic media (made here; no media in the repository) --------------------------------------

/** A w×h RGBA PNG: a lime ellipse (#dfff58, alpha 230) on a transparent surround. */
function pngLogo(width = 200, height = 80) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + 1 + x * 4;
      const inside = ((x - width / 2) / (width / 2)) ** 2 + ((y - height / 2) / (height / 2)) ** 2 <= 1;
      raw.set([0xdf, 0xff, 0x58, inside ? 230 : 0], at);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/** A mono 48 kHz WAV: a 220 Hz tone that swells, loud enough to need the peak protection. */
function wavTone(seconds = 20, rate = 48_000, level = 0.5) {
  const samples = seconds * rate;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const swell = 0.6 + 0.4 * Math.sin((2 * Math.PI * 0.5 * i) / rate);
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * level * swell * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

async function uploadLogo(page, buffer = pngLogo()) {
  await openTab(page, "Logo");
  await panelOf(page, "logo").locator('input[type="file"]').setInputFiles({ name: "logo-uji.png", mimeType: "image/png", buffer });
  const corner = panelOf(page, "logo").getByRole("radio", { name: "Kanan atas" });
  await expect(corner.or(panelOf(page, "logo").locator("[data-logo-error]"))).toBeVisible({ timeout: 60_000 });
  if (!(await corner.isVisible())) throw new Error(`logo upload: ${await panelOf(page, "logo").innerText()}`);
  await expect(corner).toBeEnabled();
}

async function uploadMusic(page, buffer = wavTone()) {
  await openTab(page, "Musik");
  const panel = panelOf(page, "music");
  const chooser = page.waitForEvent("filechooser");
  await panel.getByRole("button", { name: "Tambah musik" }).click();
  if (await panel.getByRole("button", { name: "Pilih file musik" }).isVisible()) await panel.getByRole("button", { name: "Pilih file musik" }).click();
  await (await chooser).setFiles({ name: "latar-uji.wav", mimeType: "audio/wav", buffer });
  await expect(panel.locator("[data-music-card]")).toBeVisible({ timeout: 120_000 });
}

/** Moves a range slider by key presses (keyboard only, as a keyboard user would). */
async function nudgeSlider(locator, key, times = 1) {
  await locator.focus();
  for (let i = 0; i < times; i += 1) await locator.press(key);
}

// --- the run --------------------------------------------------------------------------------------

let pageErrors = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await login(page);
  await ensureClips(page);
});

test.afterEach(async () => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  // Acceptance means no uncaught error in the page, whatever the test did.
  expect(pageErrors, "uncaught page errors").toEqual([]);
});

test("Kemampuan 1, buka klip: every clip opens from its card, ids are stable, a closed clip says why", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const listing = (await api(page, "GET", `/api/jobs/${JOB_ID}/clips`)).body.clips;
  for (const clip of listing) {
    if (clip.openable) expect(clip.clipId).toMatch(/^clip_[0-9a-f]{24}$/);
    else expect(typeof clip.reason, `clip ${clip.index} has a named reason`).toBe("string");
  }
  const again = (await api(page, "GET", `/api/jobs/${JOB_ID}/clips`)).body.clips;
  expect(again.map((clip) => clip.clipId)).toEqual(listing.map((clip) => clip.clipId));

  await page.goto(`/projects/${JOB_ID}`);
  const cards = page.getByRole("article");
  await expect(cards.first()).toBeVisible({ timeout: 30_000 });
  const count = await cards.count();
  expect(count).toBe(listing.length);
  const opened = [];
  for (let index = 0; index < count; index += 1) {
    await page.goto(`/projects/${JOB_ID}`);
    const link = page.getByRole("article").nth(index).getByRole("link", { name: "Edit klip" });
    await expect(link).toBeVisible();
    const started = Date.now();
    await link.click();
    await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 120_000 });
    const clipId = new URL(page.url()).pathname.split("/")[4];
    expect(clipId).toMatch(/^clip_[0-9a-f]{24}$/);
    await resetToSeed(page);
    // Revision 0 is the auto clip: the badge says so (or that the stage matches the export).
    await exactBadge(page, { unchangedOk: true });
    const state = await inspect(page);
    if (state.doc.base.engine.compiler === "legacy") {
      await expect(page.getByText("Klip otomatis ini dibuat sebelum editor dibuka; setelah klip diubah, tampilan teks hasil ekspor bisa sedikit berbeda")).toBeVisible();
    }
    await expect(page.getByRole("heading", { level: 1 })).not.toHaveText("");
    opened.push({ index: index + 1, clipId, openMs: Date.now() - started, engine: state.doc.base.engine.compiler });
  }
  // The clip number address opens the same clip and settles on the clip's own address.
  const second = listing.find((clip) => clip.index === 2) ?? listing[0];
  await page.goto(`/projects/${JOB_ID}/clips/klip-${second.index}/edit`);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 120_000 });
  await expect(page).toHaveURL(new RegExp(`/projects/${JOB_ID}/clips/${second.clipId}/edit$`));

  // A clip that cannot be opened names its reason and links back.
  expect(CLOSED_JOB_ID, "E2E_ACCEPT_CLOSED_JOB_ID names a job whose clips cannot be opened").not.toBe("");
  await page.goto(`/projects/${CLOSED_JOB_ID}`);
  const closedCard = page.getByRole("article").first();
  await expect(closedCard).toBeVisible({ timeout: 30_000 });
  // The card names why the clip cannot be edited (the reason arrives with the clip listing).
  const anyReason = new RegExp([...CLOSED_REASONS].map((text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
  await expect(closedCard).toContainText(anyReason, { timeout: 30_000 });
  await expect(closedCard.getByRole("link", { name: "Edit klip" })).toHaveCount(0);
  await page.goto(`/projects/${CLOSED_JOB_ID}/clips/klip-1/edit`);
  await expect(page.getByRole("heading", { name: "Klip tidak bisa dibuka" })).toBeVisible({ timeout: 120_000 });
  const reason = (await page.locator("main p").first().textContent()).trim();
  expect(CLOSED_REASONS.has(reason), `named reason: ${reason}`).toBe(true);
  await expect(page.getByRole("link", { name: "Kembali ke proyek" })).toHaveAttribute("href", `/projects/${CLOSED_JOB_ID}`);
  writeEvidence("T4.5-acceptance-1-open", { capability: 1, clips: opened, closedReason: reason, pass: true });
});

test("Kemampuan 2, trim menempel ke kata: I/O, 'Perpanjang ke sini' and the handles store only bounds frames", async ({ page }) => {
  const clip = longest();
  await start(page, clip);
  const artifact = await wordsArtifact(page);
  const ids = artifact.words.map((entry) => entry.id);
  const boundFrames = new Set(artifact.bounds.map((bound) => bound.sf));
  const before = (index) => artifact.bounds.find((bound) => bound.before === ids[index]).sf;
  const after = (index) => artifact.bounds.find((bound) => bound.after === ids[index]).sf;
  let body = await bodyWordIndexes(page);

  await selectRange(page, body[2], body[2]);
  await page.keyboard.press("i");
  await expect(word(page, body[1])).toHaveAttribute("data-zone", "before");
  const end = body.at(-3);
  await selectRange(page, end, end);
  await page.keyboard.press("o");
  await expect(word(page, body.at(-2))).toHaveAttribute("data-zone", "after");
  let saved = await waitSaved(page);
  expect(bodyOf(saved.doc).in_sf).toBe(before(body[2]));
  expect(bodyOf(saved.doc).out_sf).toBe(after(end));

  // "Perpanjang ke sini" on a word outside the clip brings it back, again at its bounds frame.
  await word(page, body[1]).scrollIntoViewIfNeeded();
  await word(page, body[1]).click();
  await toolbar(page).getByRole("button", { name: "Perpanjang ke sini" }).click();
  await expect(word(page, body[1])).toHaveAttribute("data-zone", "body");
  saved = await waitSaved(page);
  expect(bodyOf(saved.doc).in_sf).toBe(before(body[1]));

  // The timeline handles move from word gap to word gap by keyboard; the stored value is a bound.
  const handle = page.getByRole("slider", { name: "Awal klip" });
  await nudgeSlider(handle, "ArrowRight", 2);
  saved = await waitSaved(page);
  expect(boundFrames.has(bodyOf(saved.doc).in_sf), "start handle on a bounds frame").toBe(true);
  expect(bodyOf(saved.doc).in_sf).toBeGreaterThan(before(body[1]));
  await nudgeSlider(page.getByRole("slider", { name: "Akhir klip" }), "ArrowLeft", 1);
  saved = await waitSaved(page);
  expect(boundFrames.has(bodyOf(saved.doc).out_sf), "end handle on a bounds frame").toBe(true);
  await exactBadge(page);
  writeEvidence("T4.5-acceptance-2-trim", { capability: 2, inSf: bodyOf(saved.doc).in_sf, outSf: bodyOf(saved.doc).out_sf, pass: true });
  await resetToSeed(page);
  body = await bodyWordIndexes(page);
  expect(body.length).toBeGreaterThan(5);
});

test("Kemampuan 3, cold open: from a selection, edges by a word, the 0,5–8 dtk rule, suggestions, off", async ({ page }) => {
  const clip = longest();
  await start(page, clip);
  const artifact = await wordsArtifact(page);
  const body = await bodyWordIndexes(page);
  const run = findRun(artifact.words, body, { minMs: 2000, maxMs: 6000, from: Math.floor(body.length / 2) });
  expect(run, "a 2–6 s sentence for the cold open").not.toBeNull();
  await selectRange(page, run[0], run[1]);
  await page.keyboard.press("Control+Shift+H");
  await expect(word(page, run[0])).toHaveAttribute("data-cold", "");
  let saved = await waitSaved(page);
  const cold = coldOf(saved.doc);
  expect(cold).not.toBeNull();
  expect(saved.doc.main.segments[0].role).toBe("cold_open");
  expect(saved.doc.main.joins[0]).toMatchObject({ after: cold.id, style: "cut", audio_fade_ms: 30 });

  await openTab(page, "Cold open");
  const panel = panelOf(page, "coldopen");
  const line = panel.locator("[data-coldopen-line]");
  const first = await line.textContent();
  await panel.getByRole("button", { name: "Buang kata terakhir" }).click();
  await expect(line).not.toHaveText(first);
  await panel.getByRole("button", { name: "Tambah kata sesudah" }).click();
  await expect(line).toHaveText(first);
  await exactBadge(page);

  // Longer than 8 s cannot become a cold open; the reason is shown, nothing changes.
  const long = findRun(artifact.words, body, { minMs: COLD_OPEN_MAX_MS + 500, maxMs: 30_000 });
  if (long) {
    await openTab(page, "Transkrip");
    await selectRange(page, long[0], long[1]);
    await expect(toolbar(page).getByRole("button", { name: "Jadikan cold open" })).toBeDisabled();
    await openTab(page, "Cold open");
    await expect(panel.locator("[data-coldopen-reason]")).toContainText("8");
  }

  // Suggestions: each one plays and one becomes the cold open in one undoable step.
  await expect(panel.locator("[data-suggestions-state]")).not.toHaveAttribute("data-suggestions-state", "loading", { timeout: 30_000 });
  const usable = panel.getByRole("button", { name: /^Pakai saran \d+ sebagai cold open$/ });
  let used = null;
  for (const button of await usable.all()) {
    if (!(await button.isEnabled())) continue;
    used = await button.getAttribute("aria-label");
    const doc = (await inspect(page)).doc;
    await button.click();
    saved = await waitSaved(page);
    expect(contentOf(saved.doc)).not.toBe(contentOf(doc));
    expect(saved.doc.main.segments[0].role).toBe("cold_open");
    break;
  }
  const settled = await settledPlan(page);
  const length = Number(settled.pieces[0].frames);
  const fps = settled.fps;
  const ms = (length * 1000 * fps[1]) / fps[0];
  expect(ms).toBeGreaterThanOrEqual(COLD_OPEN_MIN_MS - 1);
  expect(ms).toBeLessThanOrEqual(COLD_OPEN_MAX_MS + 1);

  await panel.getByRole("switch", { name: "Cold open aktif" }).uncheck();
  saved = await waitSaved(page);
  expect(coldOf(saved.doc)).toBeNull();
  await page.getByRole("button", { name: "Urungkan" }).click();
  saved = await waitSaved(page);
  expect(coldOf(saved.doc)).not.toBeNull();
  writeEvidence("T4.5-acceptance-3-coldopen", { capability: 3, coldOpenMs: Math.round(ms), suggestionUsed: used, longRuleChecked: Boolean(long), pass: true });
  await resetToSeed(page);
});

test("Kemampuan 4, hook + saran AI: text, fit, duration, position, on/off, instant and AI suggestions", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const clip = shortest();
  await start(page, clip);
  await openTab(page, "Teks");
  const text = `Hook uji ${Date.now() % 100000}`;
  const field = page.getByRole("textbox", { name: "Teks hook" });
  await field.fill(text);
  await blur(page);
  let saved = await waitSaved(page);
  expect(hookOf(saved.doc).payload.text).toBe(text);
  await expect(page.locator("[data-hook-counter]")).toHaveText(`${[...text].length}/${HOOK_MAX_CHARS}`);
  await expect(field).toHaveAttribute("maxlength", String(HOOK_MAX_CHARS));
  await expect(page.locator("[data-hook-fit]")).toHaveText(/^(Muat|Akan terpotong)$/);
  const plan = await settledPlan(page);
  await expect(page.locator("[data-hook-fit]")).toHaveText(plan.hook?.overflow ? "Akan terpotong" : "Muat");

  const durationBefore = hookOf(saved.doc).dur_f;
  await nudgeSlider(panelOf(page, "text").getByRole("slider", { name: "Durasi hook" }), "ArrowRight", 3);
  const yBefore = hookOf(saved.doc).transform.y_e5;
  await nudgeSlider(panelOf(page, "text").getByRole("slider", { name: "Posisi hook" }), "ArrowRight", 2);
  saved = await waitSaved(page);
  expect(hookOf(saved.doc).dur_f).toBeGreaterThan(durationBefore);
  expect(hookOf(saved.doc).transform.y_e5).toBeGreaterThan(yBefore);
  await page.getByRole("switch", { name: "Tampilkan hook" }).uncheck();
  saved = await waitSaved(page);
  expect(hookOf(saved.doc)).toBeNull();
  await page.getByRole("switch", { name: "Tampilkan hook" }).check();
  saved = await waitSaved(page);
  expect(hookOf(saved.doc)?.payload?.text).toBeTruthy();
  await exactBadge(page);

  // Instant suggestions show first, with where they come from.
  const shownAt = Date.now();
  const cards = page.locator("[data-hook-suggestions] [data-suggestion]");
  await expect(cards.first()).toBeVisible({ timeout: 10_000 });
  const instantMs = Date.now() - shownAt;
  await expect(page.locator("[data-hook-suggestions] [data-source-label]").first()).toHaveText(/^(AI seleksi|Heuristik|AI)$/);
  let ai = { state: "off" };
  if (LLM) {
    // The AI part answers within its deadline: suggestions, or an honest note, never silence.
    const status = page.locator("[data-hook-suggestions] [data-ai-status]");
    await expect(status).toHaveAttribute("data-ai-status", /^(done|failed|rate_limited|notice|none)$/, { timeout: LLM_DEADLINE_MS + 10_000 });
    ai = { state: await status.getAttribute("data-ai-status"), cards: await page.getByRole("list", { name: "Saran AI" }).getByRole("listitem").count() };
    if (ai.state === "done") expect(ai.cards).toBeGreaterThan(0);
    else await expect(page.locator("[data-ai-notice]")).not.toHaveText("");
  }
  const card = page.locator('[data-hook-suggestions] [data-suggestion][data-current="false"]').first();
  const chosen = (await card.locator("p").first().textContent()).trim();
  await card.getByRole("button", { name: /^Pakai hook: / }).click();
  saved = await waitSaved(page);
  expect(hookOf(saved.doc).payload.text).toBe(chosen);
  await page.getByRole("button", { name: "Urungkan" }).click();
  saved = await waitSaved(page);
  expect(hookOf(saved.doc).payload.text).not.toBe(chosen);
  writeEvidence("T4.5-acceptance-4-hook", { capability: 4, instantMs, llm: LLM ? ai : "off", pass: true });
  await resetToSeed(page);
});

test("Kemampuan 5, caption + 4 gaya: each pack, position, size, case, colours, word fix, hide, keyword", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const clip = shortest();
  await start(page, clip);
  // At the auto clip's spot the caption reaches into the TikTok zone: a calm note, never a check (K5).
  const seedPlan = await settledPlan(page);
  if ((seedPlan.warnings ?? []).some((warning) => warning.code === "unsafe_zone" && String(warning.path ?? "").startsWith("/captions"))) {
    await openTab(page, "Teks");
    await expect(page.locator('[data-caption-zone="note"]')).toBeVisible();
    await expect(page.getByRole("button", { name: /^Perlu dicek \(\d+\)$/ })).toHaveText(/\(0\)$/);
  }
  await openTab(page, "Teks");
  const packs = page.getByRole("group", { name: "Gaya caption" });
  const shas = {};
  for (const [name, id] of [["Klasik", "classic"], ["Karaoke", "karaoke"], ["Bold", "bold"], ["Box", "box"]]) {
    await packs.getByRole("radio", { name }).check();
    const saved = await waitSaved(page);
    expect(saved.doc.captions.pack.id).toBe(id);
    shas[id] = (await settledPlan(page)).text.assSha256;
    await exactBadge(page);
  }
  expect(new Set(Object.values(shas)).size, "four packs, four distinct ASS").toBe(4);
  const text = panelOf(page, "text");
  const before = (await inspect(page)).doc.captions.overrides;
  await nudgeSlider(text.getByRole("slider", { name: "Posisi caption" }), "ArrowLeft", 4);
  await nudgeSlider(text.getByRole("slider", { name: "Ukuran caption" }), "ArrowRight", 2);
  await text.getByRole("checkbox", { name: "Huruf besar semua" }).check();
  for (const swatch of await text.getByRole("group", { name: "Warna sorot" }).getByRole("radio").all()) {
    if (await swatch.isChecked()) continue;
    await swatch.check();
    break;
  }
  let saved = await waitSaved(page);
  const after = saved.doc.captions.overrides;
  expect(after.y_e5).toBeLessThan(before.y_e5);
  expect(after.size_pm).toBeGreaterThan(before.size_pm);
  expect(after.case).toBe("upper");
  expect(after.highlight).not.toBe(before.highlight);

  const body = await bodyWordIndexes(page);
  const ids = (await wordsArtifact(page)).words.map((entry) => entry.id);
  await word(page, body[4]).dblclick();
  const editor = transcript(page).locator("input[data-word-editor]");
  await expect(editor).toBeFocused();
  await editor.fill("Diperbaiki");
  await editor.press("Enter");
  await expect(word(page, body[4])).toHaveText("Diperbaiki");
  await selectRange(page, body[6], body[6]);
  await page.keyboard.press("Control+Shift+X");
  await selectRange(page, body[8], body[8]);
  await page.keyboard.press("Control+e");
  saved = await waitSaved(page);
  const edits = saved.doc.captions.word_edits;
  expect(edits[ids[body[4]]]).toMatchObject({ text: "Diperbaiki" });
  expect(edits[ids[body[6]]]).toMatchObject({ hidden: true });
  expect(edits[ids[body[8]]]).toMatchObject({ emphasis: true });
  const plan = await settledPlan(page);
  const cued = plan.cues.flatMap((cue) => cue.words);
  expect(cued).not.toContain(ids[body[6]]);
  expect(plan.cues.find((cue) => cue.words.includes(ids[body[4]]))?.text).toMatch(/DIPERBAIKI|Diperbaiki/);
  await exactBadge(page);
  writeEvidence("T4.5-acceptance-5-captions", { capability: 5, packs: Object.keys(shas), overrides: after, pass: true });
  await resetToSeed(page);
});

test("Kemampuan 6, potong lewat transkrip: a jump cut at bounds frames, the restore chip, Rapikan in one step", async ({ page }) => {
  test.setTimeout(3 * 60_000);
  const clip = longest();
  await start(page, clip);
  const artifact = await wordsArtifact(page);
  const ids = artifact.words.map((entry) => entry.id);
  let body = await bodyWordIndexes(page);
  const first = body[6];
  const last = body[8];
  await selectRange(page, first, last);
  await page.keyboard.press("Delete");
  const chip = transcript(page).locator("button[data-removal-id]");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveText(/^⋯ \d+,\d dtk$/);
  let saved = await waitSaved(page);
  const removal = saved.doc.main.removals[0];
  expect(removal.in_sf).toBe(artifact.bounds.find((bound) => bound.before === ids[first]).sf);
  expect(removal.out_sf).toBe(artifact.bounds.find((bound) => bound.after === ids[last]).sf);
  expect(removal.words).toEqual(ids.slice(first, last + 1));
  await exactBadge(page);
  await chip.click();
  saved = await waitSaved(page);
  expect(saved.doc.main.removals).toEqual([]);

  // Rapikan: never a particle, never a reduplication; the checked items apply in one undoable step.
  const listing = (await api(page, "GET", `/api/jobs/${JOB_ID}/clips/${clip.clipId}/cleanup`)).body;
  const items = Array.isArray(listing.items) ? listing.items : [];
  const textOf = (wordIds) => (wordIds ?? []).map((id) => artifact.words.find((entry) => entry.id === id)?.t ?? "").join(" ");
  for (const item of items.filter((entry) => entry.kind === "filler")) {
    const token = textOf(item.wordIds).toLowerCase().replace(/[^\p{L}]/gu, "");
    expect(PARTICLES.has(token), `filler '${token}' is a particle`).toBe(false);
  }
  await openTab(page, "Transkrip");
  await transcript(page).getByRole("button", { name: /^Rapikan/ }).click();
  const review = page.getByRole("region", { name: "Rapikan" });
  await expect(review).toBeVisible({ timeout: 30_000 });
  const boxes = review.getByRole("checkbox");
  let applied = 0;
  if (await boxes.count()) {
    for (const box of (await boxes.all()).slice(0, 3)) if (await box.isEnabled() && !(await box.isChecked())) await box.check();
    const apply = review.getByRole("button", { name: /^Terapkan \(\d+\)/ });
    applied = Number(/\((\d+)\)/.exec(await apply.textContent())[1]);
    const doc = (await inspect(page)).doc;
    await apply.click();
    saved = await waitSaved(page);
    expect(saved.doc.main.removals.length).toBeGreaterThan(0);
    await page.getByRole("button", { name: "Urungkan" }).click();
    saved = await waitSaved(page);
    expect(contentOf(saved.doc)).toBe(contentOf(doc));
  } else {
    await expect(review).toContainText(/tidak ada/i);
  }
  writeEvidence("T4.5-acceptance-6-transcript", { capability: 6, removalFrames: [removal.in_sf, removal.out_sf], rapikanListed: items.length, applied, pass: true });
  await resetToSeed(page);
  body = await bodyWordIndexes(page);
  expect(body.length).toBeGreaterThan(5);
});

test("Kemampuan 7, tata letak: Potong tengah, Ikuti wajah and back to Latar blur, the stage exact after each", async ({ page }) => {
  test.setTimeout(10 * 60_000);
  const clip = shortest();
  await start(page, clip);
  await openTab(page, "Tata letak");
  const panel = panelOf(page, "layout");
  const initial = (await inspect(page)).doc.layout.default.mode;
  const switches = [];
  for (const [name, mode] of [["Potong tengah", "fill_center"], ["Ikuti wajah", "camera"], ["Latar blur", "fit_blur"]]) {
    const started = Date.now();
    await panel.getByRole("radio", { name: new RegExp(`^${name}`) }).check();
    await expect.poll(async () => (await inspect(page)).doc.layout.default.mode, { timeout: 8 * 60_000 }).toBe(mode);
    const saved = await waitSaved(page);
    expect(saved.doc.layout.default.mode).toBe(mode);
    await exactBadge(page, { unchangedOk: mode === initial });
    let noFace = null;
    if (mode === "camera") {
      // Spans without a face are reported, never silent: listed in the panel with a jump each.
      await expect(panel.locator("[data-layout-noface]")).toBeVisible();
      const listed = ((await settledPlan(page)).warnings ?? []).filter((warning) => warning.code === "no_face");
      noFace = listed.length;
      if (noFace) await expect(page.getByRole("button", { name: /^Perlu dicek \(\d+\)$/ })).not.toHaveText("Perlu dicek (0)");
      else await expect(panel.getByText("Wajah terdeteksi di seluruh klip.")).toBeVisible();
    }
    switches.push({ mode, exactMs: Date.now() - started, noFace });
  }
  writeEvidence("T4.5-acceptance-7-layout", { capability: 7, initial, switches, pass: true });
  await resetToSeed(page);
});

test("Kemampuan 8, logo: upload, corners, size, opacity, keyboard move, the safe-zone nudge, the export shows it", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const clip = shortest();
  await start(page, clip);
  const started = Date.now();
  await uploadLogo(page);
  const uploadMs = Date.now() - started;
  const panel = panelOf(page, "logo");
  for (const corner of ["Kiri atas", "Kanan atas", "Kiri bawah", "Kanan bawah"]) {
    await panel.getByRole("radio", { name: corner }).check();
    await waitSaved(page);
    // Every preset sits outside the TikTok zone (W3 fix): no logo check appears.
    await expect(panel.locator("[data-logo-unsafe]")).toHaveCount(0);
  }
  await panel.getByRole("radio", { name: "Kanan atas" }).check();
  const before = logoOf((await waitSaved(page)).doc).transform;
  await nudgeSlider(panel.getByRole("slider", { name: "Ukuran" }), "ArrowRight", 5);
  await nudgeSlider(panel.getByRole("slider", { name: "Opasitas" }), "ArrowLeft", 3);
  let saved = await waitSaved(page);
  expect(logoOf(saved.doc).transform.w_e5).toBeGreaterThan(before.w_e5);
  expect(logoOf(saved.doc).transform.opacity_pm).toBeLessThan(before.opacity_pm);
  const box = page.locator('[data-gizmo="logo"] [data-logo-box]');
  await expect(box).toBeVisible();
  const xBefore = logoOf(saved.doc).transform.x_e5;
  await box.focus();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press("Shift+ArrowLeft");
  saved = await waitSaved(page);
  expect(logoOf(saved.doc).transform.x_e5, "the logo moves by keyboard").toBeLessThan(xBefore);
  // Into the zone (down to the bottom bar) → the warning offers "Geser ke area aman".
  await box.focus();
  for (let i = 0; i < 120; i += 1) await page.keyboard.press("Shift+ArrowDown");
  await waitSaved(page);
  await expect(panel.locator("[data-logo-unsafe]")).toBeVisible();
  await panel.getByRole("button", { name: "Geser ke area aman" }).click();
  saved = await waitSaved(page);
  await expect(panel.locator("[data-logo-unsafe]")).toHaveCount(0);
  await exactBadge(page);
  const logoBox = (await settledPlan(page)).logo.box;

  // The export carries the logo: the mean colour at its centre is the logo's lime.
  const { dialog } = await exportClip(page);
  const file = await download(page, dialog, "Unduh MP4");
  const verified = await expectExportGates(page, dialog, saved.doc, file);
  const centre = { x: logoBox.x + Math.floor(logoBox.w / 2) - 4, y: logoBox.y + Math.floor(logoBox.h / 2) - 4, w: 8, h: 8 };
  const rgb = meanRgb(file, 1.0, centre);
  expect(rgb[1], `logo green at ${JSON.stringify(centre)}: ${rgb}`).toBeGreaterThanOrEqual(150);
  expect(rgb[1] - rgb[2], `logo lime at ${JSON.stringify(centre)}: ${rgb}`).toBeGreaterThanOrEqual(60);
  await dialog.getByRole("button", { name: "Tutup" }).click();
  writeEvidence("T4.5-acceptance-8-logo", { capability: 8, uploadMs, box: logoBox, centreRgb: rgb, gates: verified.report?.gates?.map((gate) => gate.name), pass: true });
  await resetToSeed(page);
});

test("Kemampuan 9, musik + ducking: upload, volume, start, loop, fades, presets, loudness; the export peaks ≤ −1 dBTP", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  const clip = shortest();
  await start(page, clip);
  const started = Date.now();
  // A bed at a normal level: −14 LUFS is reachable without clamping, so the file's G3 can be
  // re-checked here from the document alone (a clamped export is checked by the worker itself).
  await uploadMusic(page, wavTone(12, 48_000, 0.25));
  const uploadMs = Date.now() - started;
  const panel = panelOf(page, "music");
  let saved = await waitSaved(page);
  const initial = musicOf(saved.doc).payload;
  await nudgeSlider(panel.getByRole("slider", { name: "Volume musik" }), "ArrowRight", 2);
  await nudgeSlider(panel.getByRole("slider", { name: "Mulai dari" }), "ArrowRight", 2);
  await panel.getByRole("switch", { name: "Ulangi sampai klip selesai" }).check();
  await nudgeSlider(panel.getByRole("slider", { name: "Muncul perlahan" }), "ArrowRight", 10);
  await nudgeSlider(panel.getByRole("slider", { name: "Hilang perlahan" }), "ArrowRight", 10);
  saved = await waitSaved(page);
  const payload = musicOf(saved.doc).payload;
  expect(payload.gain_cdb).not.toBe(initial.gain_cdb);
  expect(payload.src_in_smp).toBeGreaterThan(initial.src_in_smp);
  expect(payload.loop).toBe(true);
  expect(payload.fade_in_f).toBeGreaterThan(0);
  expect(payload.fade_out_f).toBeGreaterThan(0);
  for (const [name, depth] of Object.entries(DUCK_DEPTH_CDB)) {
    await panel.getByRole("radio", { name: new RegExp(`^${name}`) }).check();
    saved = await waitSaved(page);
    expect(musicOf(saved.doc).payload.duck).toMatchObject({ on: true, depth_cdb: depth });
  }
  await panel.getByRole("switch", { name: /^Samakan kenyaringan/ }).check();
  saved = await waitSaved(page);
  expect(saved.doc.audio.master.mode).toBe("normalize");
  await expect(page.locator('[data-lane="music"]').getByRole("img", { name: /turun saat ada suara/ })).toBeVisible();
  await exactBadge(page);

  const { dialog, doneMs, render } = await exportClip(page);
  const file = await download(page, dialog, "Unduh MP4");
  const verified = await expectExportGates(page, dialog, saved.doc, file);
  const peakGate = verified.report?.gates?.find((gate) => gate.name === "G3b");
  expect(peakGate?.ok, "G3b ran on the export").toBe(true);
  expect(peakGate.values.tp_cdb / 100, "true peak in dBTP").toBeLessThanOrEqual(TRUE_PEAK_MAX_DBTP);
  const rate = JSON.parse(probe(file, "stream=sample_rate")).streams[0].sample_rate;
  expect(Number(rate)).toBe(48_000);
  await dialog.getByRole("button", { name: "Tutup" }).click();
  writeEvidence("T4.5-acceptance-9-music", { capability: 9, uploadMs, renderMs: doneMs, completedBy: render.completedBy, payload: musicOf(saved.doc).payload,
    gates: verified.report?.gates?.map((gate) => ({ name: gate.name, ok: gate.ok })), sampleRate: Number(rate), pass: true });
  await resetToSeed(page);
});

test("Kemampuan 10, waveform + penanda: the speech waveform, markers that seek, an honest note when data is missing", async ({ page }) => {
  const clip = longest();
  await start(page, clip);
  await expect(page.locator('[data-lane="audio"]')).toHaveAttribute("data-waveform-state", "ready", { timeout: 30_000 });
  await expect(page.locator('[data-lane="audio"]').getByRole("img", { name: "Waveform suara klip" })).toBeVisible();
  const lane = page.locator('[data-lane="markers"]');
  await expect(lane).toHaveAttribute("data-markers-state", /^(ready|empty)$/, { timeout: 30_000 });
  const artifact = await wordsArtifact(page);
  const markers = lane.locator("[data-event-marker]");
  const count = await markers.count();
  const kinds = {};
  if (count > 0) {
    for (const marker of await markers.all()) {
      const kind = await marker.getAttribute("data-kind");
      kinds[kind] = (kinds[kind] ?? 0) + 1;
      await expect(marker).toHaveAttribute("aria-label", /\S/);
    }
    const target = markers.nth(Math.min(1, count - 1));
    const f0 = Number(await target.getAttribute("data-f0"));
    await target.click();
    await expect.poll(() => page.evaluate(() => globalThis.__potonginEditorInspect.player().frame)).toBe(f0);
    // The keyboard walks the markers (one tab stop, arrows inside).
    await target.focus();
    await page.keyboard.press("Home");
    await expect(markers.first()).toBeFocused();
  }
  if (artifact.missing.length) {
    await expect(page.getByText(/tidak tersedia untuk job ini/)).toBeVisible();
  } else if (count === 0) {
    await expect(lane.locator("[data-markers-empty]")).toBeVisible();
  }
  writeEvidence("T4.5-acceptance-10-markers", { capability: 10, markers: count, kinds, missing: artifact.missing, pass: true });
});

test("Kemampuan 11, delapan bug editor lama: each one is impossible here (§8, editor side)", async ({ page }) => {
  test.setTimeout(20 * 60_000);
  const clip = shortest();
  await start(page, clip);
  const results = {};
  const body = await bodyWordIndexes(page);
  const ids = (await wordsArtifact(page)).words.map((entry) => entry.id);

  // Bug 1: the box pack's background follows its opacity (alpha on OutlineColour, BorderStyle 3).
  await openTab(page, "Teks");
  await page.getByRole("group", { name: "Gaya caption" }).getByRole("radio", { name: "Box" }).check();
  await waitSaved(page);
  await settledPlan(page);
  let ass = await currentAss(page);
  const format = ass.split("\n").find((line) => line.startsWith("Format:") && line.includes("OutlineColour")).slice(7).split(",").map((field) => field.trim());
  const styles = ass.split("\n").filter((line) => line.startsWith("Style:")).map((line) => line.slice(6).split(",").map((field) => field.trim()));
  const boxStyle = styles.find((values) => values[format.indexOf("Name")] === "Box");
  expect(boxStyle, "the Box style is in the ASS").toBeTruthy();
  const field = (name) => boxStyle[format.indexOf(name)];
  expect(field("BorderStyle")).toBe("3");
  // The pack's 75 % background: alpha 0x40 on OutlineColour (the bug left the box opaque).
  expect(field("OutlineColour")).toMatch(/^&H40[0-9A-F]{6}$/i);
  results.boxOpacity = { BorderStyle: field("BorderStyle"), OutlineColour: field("OutlineColour") };

  // Bug 3: text that looks like ASS stays text (escaped), Bug 6: a keyword takes its colour.
  await openTab(page, "Transkrip");
  await word(page, body[3]).dblclick();
  const editor = transcript(page).locator("input[data-word-editor]");
  await editor.fill("{\\b1}\\N");
  await editor.press("Enter");
  await selectRange(page, body[5], body[5]);
  await page.keyboard.press("Control+e");
  const saved = await waitSaved(page);
  await settledPlan(page);
  ass = await currentAss(page);
  const dialogue = ass.split("\n").filter((line) => line.startsWith("Dialogue:"));
  expect(dialogue.some((line) => line.includes("{\\b1}")), "no raw override block").toBe(false);
  // ass_escape: a brace becomes "\{" and a backslash "\" + WORD JOINER, so libass draws them as text.
  const escaped = dialogue.filter((line) => line.includes("\\{\\\u2060b1\\}\\\u2060N"));
  expect(escaped.length, "the edited word is in the ASS, escaped").toBeGreaterThan(0);
  const swatch = saved.doc.captions.overrides.emphasis.replace("#", "");
  const bgr = `${swatch.slice(4, 6)}${swatch.slice(2, 4)}${swatch.slice(0, 2)}`.toUpperCase();
  expect(dialogue.some((line) => line.toUpperCase().includes(`\\1C&H${bgr}&`)), `keyword colour &H${bgr}& in the ASS`).toBe(true);
  results.escape = true;
  results.keyword = `&H${bgr}&`;

  // Bug 2: captions are never cut with "…": every visible word is in exactly one cue.
  const plan = await settledPlan(page);
  expect(plan.cues.some((cue) => cue.text.includes("…")), "no cue ends in an ellipsis").toBe(false);
  const cued = plan.cues.flatMap((cue) => cue.words);
  // A cold open shows its words again later in the body: one cue per word within each piece.
  for (const piece of plan.pieces) {
    const inPiece = plan.cues.filter((cue) => cue.f0 >= piece.outF0 && cue.f0 < piece.outF0 + piece.frames).flatMap((cue) => cue.words);
    expect(new Set(inPiece).size, `piece ${piece.i}: each word in one cue`).toBe(inPiece.length);
  }
  expect(plan.cues.every((cue) => cue.words.length <= 4)).toBe(true);
  results.cues = { count: plan.cues.length, words: cued.length };

  // Bug 5: a logo renders (the derived bitmap has the planned box size).
  await uploadLogo(page);
  await waitSaved(page);
  const logoPlan = (await settledPlan(page)).logo;
  const derived = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: "same-origin" });
    const bitmap = await createImageBitmap(await response.blob());
    return { status: response.status, type: response.headers.get("content-type"), w: bitmap.width, h: bitmap.height };
  }, logoPlan.url);
  expect(derived).toMatchObject({ status: 200, type: "image/png", w: logoPlan.box.w, h: logoPlan.box.h });
  results.logo = { box: logoPlan.box, derived };

  // Bug 4: loudness normalisation stays at 48 kHz.
  await openTab(page, "Musik");
  await panelOf(page, "music").getByRole("switch", { name: /^Samakan kenyaringan/ }).check();
  const exported = await waitSaved(page);
  const { dialog, render } = await exportClip(page);
  const file = await download(page, dialog, "Unduh MP4");
  const rate = Number(JSON.parse(probe(file, "stream=sample_rate")).streams[0].sample_rate);
  expect(rate).toBe(48_000);
  const verified = await expectExportGates(page, dialog, exported.doc, file);
  results.normalize = { sampleRate: rate, clampedAt: verified.clampedAt ?? null };
  await dialog.getByRole("button", { name: "Tutup" }).click();

  // Bug 8: the export's name is its render key, and that key covers the compiler version: a
  // compiler fix gives a new key, so old renders are never reused after a fix.
  const stem = path.basename(jobFile(render.resultUrl), ".mp4");
  const docFile = path.join(scratchDir(), "doc.json");
  writeFileSync(docFile, JSON.stringify(exported.doc));
  const keys = JSON.parse(execFileSync(PYTHON, ["-c", [
    "import json, sys",
    "from pathlib import Path",
    "from ai_clipper.edit_v2 import plan as P, render_edit",
    "doc = json.loads(Path(sys.argv[2]).read_text())",
    "resources = P.Resources(render_edit.RESOURCES_DIR)",
    "plan = render_edit.load_render_inputs(Path(sys.argv[1]), doc, resources=resources).plan",
    "args = dict(size=(doc['output']['w'], doc['output']['h']), quality='standar', measure_sha=None, toolchain_sha=P.toolchain_sha256(resources))",
    "key = P.render_key(plan, **args)",
    "P.COMPILER_VERSION = P.COMPILER_VERSION + '+bump'",
    "print(json.dumps({'key': key, 'bumped': P.render_key(plan, **args)}))",
  ].join("\n"), path.join(JOBS_ROOT, JOB_ID), docFile], { encoding: "utf8", cwd: repoRoot, env: { ...CHILD_ENV(), PYTHONPATH: path.join(repoRoot, "src") } }).trim().split("\n").at(-1));
  expect(keys.key.startsWith(stem), `export ${stem} is named by its render key`).toBe(true);
  expect(keys.bumped).not.toBe(keys.key);
  results.renderKey = { file: stem, changesWithCompiler: true };

  // Bug 7: saving never stops: more than 200 saves in a row, and the receipts stay at 200.
  const receiptsDir = path.join(JOBS_ROOT, JOB_ID, "analysis", "clips", clip.clipId, "edit", "receipts");
  const saves = await page.evaluate(async ({ jobId, clipId, count }) => {
    const url = `/api/jobs/${jobId}/clips/${clipId}/edit`;
    let current = await (await fetch(url, { credentials: "same-origin", cache: "no-store" })).json();
    let ok = 0;
    for (let i = 0; i < count; i += 1) {
      const doc = structuredClone(current.doc);
      doc.revision += 1;
      doc.parent_sha256 = current.etag;
      doc.captions.overrides.size_pm = doc.captions.overrides.size_pm === 1000 ? 1050 : 1000;
      const response = await fetch(url, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json",
        "If-Match": `"${current.etag}"`, "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify(doc) });
      if (response.status !== 200) return { ok, status: response.status, body: await response.text() };
      const saved = await response.json();
      current = { doc: saved.doc, etag: saved.etag };
      ok += 1;
    }
    return { ok, status: 200 };
  }, { jobId: JOB_ID, clipId: clip.clipId, count: RECEIPTS_KEEP + 15 });
  expect(saves, JSON.stringify(saves)).toMatchObject({ ok: RECEIPTS_KEEP + 15, status: 200 });
  const receipts = readdirSync(receiptsDir).filter((name) => name.endsWith(".json")).length;
  expect(receipts).toBeLessThanOrEqual(RECEIPTS_KEEP);
  results.saves = { count: saves.ok, receipts };

  writeEvidence("T4.5-acceptance-11-legacy-bugs", { capability: 11, results, pass: true });
  await openEditor(page, clip.clipId);
  await resetToSeed(page);
});

test("Kemampuan 12, urungkan, simpan otomatis, konflik: 200 steps, merged drags, autosave, reload, two tabs", async ({ page, browser }) => {
  test.setTimeout(8 * 60_000);
  const clip = longest();
  await start(page, clip);
  await openTab(page, "Teks");
  const upper = panelOf(page, "text").getByRole("checkbox", { name: "Huruf besar semua" });
  // 205 single steps: undo goes back 200 of them, never further.
  for (let i = 0; i < UNDO_DEPTH + 5; i += 1) await upper.click();
  await waitSaved(page, 60_000);
  await blur(page);
  for (let i = 0; i < UNDO_DEPTH; i += 1) await page.keyboard.press("Control+z");
  const undone = await inspect(page);
  expect(undone.canUndo).toBe(false);
  // 205 toggles from "asis": after 5 the case is "upper" (odd), which is where undo stops.
  expect(undone.doc.captions.overrides.case).toBe("upper");
  await page.keyboard.press("Control+Shift+z");
  expect((await inspect(page)).doc.captions.overrides.case).toBe("asis");
  await waitSaved(page);
  await resetToSeed(page);

  // A slider moved by many key presses is one undo step.
  await openTab(page, "Teks");
  const size = panelOf(page, "text").getByRole("slider", { name: "Ukuran caption" });
  const sizeBefore = (await inspect(page)).doc.captions.overrides.size_pm;
  await nudgeSlider(size, "ArrowRight", 6);
  const savedAt = Date.now();
  let saved = await waitSaved(page);
  const autosaveMs = Date.now() - savedAt;
  expect(saved.doc.captions.overrides.size_pm).toBeGreaterThan(sizeBefore);
  await blur(page);
  await page.keyboard.press("Control+z");
  expect((await inspect(page)).doc.captions.overrides.size_pm).toBe(sizeBefore);
  saved = await waitSaved(page);
  await expect(page.getByTestId("save-status")).toHaveText(/^Tersimpan/);

  // Reload before the autosave: nothing is lost (U7).
  await page.getByRole("textbox", { name: "Teks hook" }).fill("Hook sebelum muat ulang");
  await blur(page);
  await page.getByRole("group", { name: "Gaya caption" }).getByRole("radio", { name: "Box" }).check();
  const before = await inspect(page);
  expect(before.commands).toBeGreaterThan(0);
  await page.reload();
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 60_000 });
  const after = await waitSaved(page);
  expect(contentOf(after.doc)).toBe(contentOf(before.doc));

  // Two tabs: both see the warning; edits to different parts both survive.
  const second = await page.context().newPage();
  await openEditor(second, clip.clipId);
  await expect(page.getByText("Klip ini terbuka di tab lain")).toBeVisible();
  await expect(second.getByText("Klip ini terbuka di tab lain")).toBeVisible();
  await openTab(page, "Teks");
  await page.getByRole("textbox", { name: "Teks hook" }).fill("Hook dari tab A");
  await blur(page);
  const body = await bodyWordIndexes(second);
  await word(second, body[5]).dblclick();
  await transcript(second).locator("input[data-word-editor]").fill("TabB");
  await transcript(second).locator("input[data-word-editor]").press("Enter");
  await waitSaved(page);
  await waitSaved(second);
  const server = (await api(page, "GET", `/api/jobs/${JOB_ID}/clips/${clip.clipId}/edit`)).body;
  expect(hookOf(server.doc).payload.text).toBe("Hook dari tab A");
  expect(Object.values(server.doc.captions.word_edits).some((edit) => edit.text === "TabB")).toBe(true);
  await second.close();

  // "Kembali ke versi AI" is one step: one Urungkan brings the edits back.
  await page.reload();
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 60_000 });
  const edited = await waitSaved(page);
  await page.getByRole("button", { name: "Kembali ke versi AI" }).click();
  saved = await waitSaved(page);
  expect(contentOf(saved.doc)).toBe(contentOf(saved.seed));
  await page.getByRole("button", { name: "Urungkan" }).click();
  saved = await waitSaved(page);
  expect(contentOf(saved.doc)).toBe(contentOf(edited.doc));
  writeEvidence("T4.5-acceptance-12-history", { capability: 12, undoDepth: UNDO_DEPTH, savedAfterLastKeyMs: autosaveMs,
    autosaveDebounceMs: AUTOSAVE_MS, pass: true });
  await resetToSeed(page);
});

test("Kemampuan 13, ekspor lewat antrean: stages, MP4 + SRT, G1–G3, the same key reused, cancel, the auto file for an unchanged clip", async ({ page }) => {
  test.setTimeout(30 * 60_000);
  const clip = shortest();
  await start(page, clip);
  await openTab(page, "Teks");
  await page.getByRole("textbox", { name: "Teks hook" }).fill(`Hook ekspor ${Date.now() % 100000}`);
  await blur(page);
  const state = await waitSaved(page);

  await page.getByRole("button", { name: "Ekspor", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Ekspor klip" });
  await expect(dialog.getByText("720×1280, kualitas sama dengan klip otomatis")).toBeVisible();
  // Notes (the caption at the auto clip's spot, K5) are shown without a tick box.
  const notes = await dialog.locator("[data-export-note]").count();
  await dialog.getByRole("button", { name: "Tutup" }).click();
  const first = await exportClip(page);
  expect(first.render.state).toBe("completed");
  expect(first.render.completedBy).toBe("render");
  for (const stage of ["Merender", "Memverifikasi"]) expect(first.steps.join("|"), `stage ${stage} shown`).toContain(stage);
  const mp4 = await download(page, first.dialog, "Unduh MP4");
  const srt = await download(page, first.dialog, "Unduh SRT");
  expect(path.basename(mp4)).toBe(`klip-${String(clip.index).padStart(2, "0")}-revisi-${first.render.revision}.mp4`);
  expect(path.basename(srt)).toBe(`klip-${String(clip.index).padStart(2, "0")}-revisi-${first.render.revision}.srt`);
  expect(readFileSync(srt, "utf8")).toMatch(/^\d+\r?\n\d\d:\d\d:\d\d,\d{3} --> /m);
  const verified = await expectExportGates(page, first.dialog, state.doc, mp4);
  await expect(first.dialog.getByRole("button", { name: "Salin judul" })).toBeVisible();
  await first.dialog.getByRole("button", { name: "Tutup" }).click();

  // The same document again: the finished file is reused at once.
  const again = await exportClip(page, { timeout: 60_000 });
  expect(again.render.completedBy).toBe("key");
  await expect(again.dialog.getByRole("list", { name: "Ekspor sebelumnya" })).toBeVisible();
  await again.dialog.getByRole("button", { name: "Tutup" }).click();

  // A render can be cancelled; nothing is published.
  await page.getByRole("textbox", { name: "Teks hook" }).fill(`Hook batal ${Date.now() % 100000}`);
  await blur(page);
  await waitSaved(page);
  await page.getByRole("button", { name: "Ekspor", exact: true }).click();
  for (const box of await dialog.getByRole("checkbox").all()) await box.check();
  await dialog.getByRole("button", { name: "Mulai ekspor" }).click();
  await dialog.getByRole("button", { name: "Batalkan ekspor" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible({ timeout: 60_000 });
  await expect(dialog.getByRole("button", { name: "Coba lagi" })).toBeVisible();
  await expect(dialog.getByRole("link", { name: "Unduh MP4" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Tutup" }).click();

  // An unchanged clip exports the auto file itself (R10, same inode).
  await page.getByRole("button", { name: "Kembali ke versi AI" }).click();
  await waitSaved(page);
  await page.getByRole("button", { name: "Ekspor", exact: true }).click();
  await expect(dialog.getByText("Tanpa perubahan: file klip otomatis dipakai langsung")).toBeVisible();
  await dialog.getByRole("button", { name: "Tutup" }).click();
  const auto = await exportClip(page, { timeout: 120_000 });
  expect(auto.render.completedBy).toBe("seed");
  const autoFile = path.join(JOBS_ROOT, JOB_ID, "output", `clip-${String(clip.index).padStart(2, "0")}.mp4`);
  const exported = statSync(jobFile(auto.render.resultUrl));
  const original = statSync(autoFile);
  expect(exported.ino === original.ino && exported.dev === original.dev, "the auto file itself").toBe(true);
  await auto.dialog.getByRole("button", { name: "Tutup" }).click();
  writeEvidence("T4.5-acceptance-13-export", { capability: 13, clipDurationMs: clip.durationMs, renderMs: first.doneMs, steps: first.steps,
    notes, reusedBy: again.render.completedBy, cancelled: true, r10: auto.render.completedBy,
    gates: verified.report?.gates?.map((gate) => ({ name: gate.name, ok: gate.ok })), pass: true });
});

// --- QG-A11Y --------------------------------------------------------------------------------------

/**
 * Keyboard reach of one region: every enabled control is focusable by Tab, or belongs to a group
 * with one tab stop (radios of one name, the tabs, the markers toolbar) whose stop was reached.
 * Each element focused shows a ring (outline or box-shadow).
 */
async function keyboardWalk(page, scope, maxStops = 160) {
  await page.locator(scope).first().evaluate((element) => element.scrollIntoView());
  await page.evaluate(() => document.activeElement?.blur?.());
  const start = page.locator(scope).first();
  await start.evaluate((element) => {
    const probe = document.createElement("span");
    probe.tabIndex = -1;
    probe.dataset.walkStart = "";
    element.prepend(probe);
    probe.focus();
  });
  const visited = [];
  for (let i = 0; i < maxStops; i += 1) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate((selector) => {
      const element = document.activeElement;
      if (!element || element === document.body) return { inside: false };
      const inside = Boolean(element.closest(selector));
      if (!element.dataset.walkId) element.dataset.walkId = String(Math.random()).slice(2);
      // A native control laid invisibly over its card (radios, swatches) draws the ring on the card.
      const ringOn = (node) => {
        if (!node) return false;
        const style = getComputedStyle(node);
        return (style.outlineStyle !== "none" && style.outlineWidth !== "0px") || style.boxShadow !== "none";
      };
      return { inside, id: element.dataset.walkId, name: element.getAttribute("aria-label") || element.textContent.trim().slice(0, 40)
        || element.closest("label")?.textContent.trim().slice(0, 40) || element.tagName.toLowerCase(),
      ring: ringOn(element) || ringOn(element.closest("label")) || ringOn(element.parentElement) };
    }, scope);
    if (!info.inside) break;
    visited.push(info);
  }
  await page.locator("[data-walk-start]").evaluateAll((nodes) => nodes.forEach((node) => node.remove()));
  const report = await page.evaluate(({ selector, seen }) => {
    const root = document.querySelector(selector);
    const reached = new Set(seen);
    const controls = [...root.querySelectorAll("button, input, select, textarea, a[href], summary, [role='slider'], [role='switch'], [tabindex]")]
      .filter((element) => !element.disabled && element.getAttribute("aria-hidden") !== "true" && !element.closest("[hidden], [aria-hidden='true']")
        && element.offsetParent !== null && !(element.type === "file") && element.dataset.walkStart === undefined
        && Number(element.getAttribute("tabindex") ?? 0) >= -1);
    const missed = [];
    for (const element of controls) {
      if (reached.has(element.dataset.walkId)) continue;
      const group = element.type === "radio" ? [...root.querySelectorAll(`input[type="radio"][name="${CSS.escape(element.name)}"]`)]
        : element.getAttribute("role") === "tab" ? [...root.querySelectorAll("[role='tab']")]
          : element.closest("[role='toolbar']") && element.getAttribute("tabindex") === "-1" ? [...element.closest("[role='toolbar']").querySelectorAll("[tabindex]")]
            : null;
      if (group && group.some((member) => reached.has(member.dataset.walkId))) continue;
      // Behind a closed <details>: reachable by keyboard once its summary opens it (Enter).
      const closed = element.closest("details:not([open])");
      if (closed && element.tagName !== "SUMMARY" && reached.has(closed.querySelector("summary")?.dataset.walkId)) continue;
      if (element.getAttribute("tabindex") === "-1" && !group) continue; // programmatic focus targets
      missed.push(`${element.tagName.toLowerCase()}${element.type ? `[${element.type}]` : ""}: ${(element.getAttribute("aria-label") || element.textContent || element.name || "").trim().slice(0, 40)}`);
    }
    return { controls: controls.length, missed };
  }, { selector: scope, seen: visited.map((entry) => entry.id) });
  return { stops: visited.length, noRing: visited.filter((entry) => !entry.ring).map((entry) => entry.name), ...report };
}

async function axeRun(page) {
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const report = await globalThis.axe.run(document, { resultTypes: ["violations"] });
    return report.violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.length,
      targets: item.nodes.slice(0, 3).map((node) => `${node.target.join(" ")} :: ${(node.any[0]?.message ?? node.failureSummary ?? "").slice(0, 160)}`) }));
  });
}

test("QG-A11Y: axe finds no critical or serious violation in any panel or dialog; every control is reachable by keyboard", async ({ page, browser }) => {
  test.skip(!AXE, "set AXE_CORE_PATH to an axe.min.js (axe-core is not a web dependency)");
  test.setTimeout(15 * 60_000);
  const clip = shortest();
  const results = [];
  const walks = [];
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await start(page, clip);
    // A logo and music make their panels and lanes show every control.
    await uploadLogo(page);
    await uploadMusic(page);
    await waitSaved(page);
    const record = async (state) => results.push({ viewport: `${viewport.width}x${viewport.height}`, state, violations: await axeRun(page) });
    const walk = async (state, scope) => {
      const report = await keyboardWalk(page, scope);
      walks.push({ viewport: `${viewport.width}x${viewport.height}`, state, ...report });
    };
    await record("ready");
    await walk("top bar", '[data-slot="topBar"]');
    await walk("stage controls", '[data-slot="stage"]');
    await walk("timeline", '[data-slot="timeline"]');
    for (const [tab, id] of [["Transkrip", "transcript"], ["Teks", "text"], ["Cold open", "coldopen"], ["Tata letak", "layout"],
      ["Logo", "logo"], ["Musik", "music"]]) {
      await openTab(page, tab);
      await expect(panelOf(page, id)).toHaveAttribute("aria-busy", "false", { timeout: 30_000 });
      await record(`${tab} panel`);
      await walk(`${tab} panel`, `[data-panel="${id}"]`);
    }
    await openTab(page, "Transkrip");
    await transcript(page).getByRole("button", { name: /^Rapikan/ }).click();
    await expect(page.getByRole("region", { name: "Rapikan" })).toBeVisible({ timeout: 30_000 });
    await record("Rapikan review");
    await page.getByRole("button", { name: /^Perlu dicek/ }).click();
    await record("Perlu dicek");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Apa artinya?" }).click();
    await record("badge help");
    await page.keyboard.press("Escape");
    await blur(page);
    await page.keyboard.press("?");
    await expect(page.getByRole("dialog", { name: "Pintasan keyboard" })).toBeVisible();
    await record("shortcut help");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Zona aman" }).click();
    await record("safe zone on");
    await page.getByRole("button", { name: "Zona aman" }).click();
    await page.getByRole("button", { name: "Ekspor", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Ekspor klip" })).toBeVisible();
    await record("export dialog");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Ekspor klip" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ekspor", exact: true })).toBeFocused();
    await resetToSeed(page);
  }
  const blocking = results.flatMap((entry) => entry.violations.filter((item) => ["critical", "serious"].includes(item.impact))
    .map((item) => ({ state: entry.state, viewport: entry.viewport, ...item })));
  const missed = walks.filter((entry) => entry.missed.length || entry.noRing.length);
  writeEvidence("T4.5-QG-A11Y", { gate: "QG-A11Y (real stack, every panel and dialog, both viewports)", browser: browser.version(),
    axe: "4.13.0", states: results.length, critical: blocking.filter((item) => item.impact === "critical").length,
    serious: blocking.filter((item) => item.impact === "serious").length,
    other: results.reduce((sum, entry) => sum + entry.violations.filter((item) => !["critical", "serious"].includes(item.impact)).length, 0),
    results, keyboard: walks, pass: blocking.length === 0 && missed.length === 0 });
  expect(blocking).toEqual([]);
  expect(missed.map((entry) => ({ state: entry.state, viewport: entry.viewport, missed: entry.missed, noRing: entry.noRing }))).toEqual([]);
});
