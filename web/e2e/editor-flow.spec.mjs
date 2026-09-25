// Editor V3, the whole W2 flow on the real stack (plan §11.2 T2.Z "The e2e flow" and the W2 exit
// gate): a real Next server and render worker with POTONGIN_EDITOR_V3=on, a JOBS_ROOT holding a
// copy of real V3 jobs, the real store, player, preview lane and export queue.
//
//   open → trim → delete words → fix a word → switch pack → edit the hook → change the cold open
//   → undo/redo → reload → export → download → G1–G3 on the file → undo everything → export →
//   the auto file itself (R10)
//
// plus QG-CONFLICT with two tabs, the scripted QG-UX tasks U1, U2, U3, U6 and U7 with their time
// limits, PF-OPEN, the editor headers (cross-origin isolated) and QG-A11Y (axe) on the real page.
//
// Setup (every value is required unless marked optional):
//   E2E_BASE_URL, E2E_USERNAME, E2E_PASSWORD      a private server (never the owner's :3000)
//   E2E_EDITOR_JOB_ID                            a V3 job in that server's JOBS_ROOT (a copy)
//   E2E_JOBS_ROOT                                that JOBS_ROOT (G1–G3 and R10 read files there)
//   E2E_EDITOR_PYTHON (optional)                 a Python with ai_clipper (default: python3)
//   EDITOR_GATES_OUT (optional)                  where the gate evidence JSON is written
//   AXE_CORE_PATH (optional)                     axe.min.js for QG-A11Y (skipped without it)
// The browser is Chrome for Testing 147.0.7727.15 (Playwright build 1217) when installed, as for
// the parity specs; PARITY_CHROME overrides it. Run:
//   E2E_NO_WEB_SERVER=1 npx playwright test e2e/editor-flow.spec.mjs --project=desktop-chromium
import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { login, settings } from "./support/harness.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const JOB_ID = process.env.E2E_EDITOR_JOB_ID || "";
const JOBS_ROOT = process.env.E2E_JOBS_ROOT || "";
const PYTHON = process.env.E2E_EDITOR_PYTHON || "python3";
const GATES_OUT = process.env.EDITOR_GATES_OUT || "";
const AXE = process.env.AXE_CORE_PATH && existsSync(process.env.AXE_CORE_PATH) ? readFileSync(process.env.AXE_CORE_PATH, "utf8") : null;

// Plan §10.2 QG-UX and §10.3 PF-OPEN limits (never weakened here).
const U1_MS = 20_000;
const U2_MS = 20_000;
const U3_MS = 45_000;
const U6_EXTRA_MS = 30_000;
const U7_RESET_MS = 20_000;
const PF_OPEN_FIRST_MS = 3_000;
const PF_OPEN_REPEAT_MS = 2_000;
const PF_OPEN_CELL_MS = 2_000;

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
test.skip(!JOB_ID || !JOBS_ROOT, "E2E_EDITOR_JOB_ID and E2E_JOBS_ROOT name a copy of a real V3 job on a private server");

/**
 * An API call made by the page itself (same origin, the session cookie, which is `Secure` and so
 * never sent by Playwright's own request client over http://127.0.0.1): `{status, body}`.
 */
async function api(page, method, url, json) {
  return page.evaluate(async ({ method: verb, url: target, json: body }) => {
    const init = { method: verb, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    const response = await fetch(target, init);
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed };
  }, { method, url, json });
}

let clips = null; // [{clipId, index, durationMs, title}] after the job-level prepare
const evidence = {};

function writeEvidence(name, value) {
  evidence[name] = value;
  if (!GATES_OUT) return;
  mkdirSync(GATES_OUT, { recursive: true });
  writeFileSync(path.join(GATES_OUT, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function browserInfo(browser) {
  return { browser: `Chrome for Testing ${browser.version()}`, executable: chrome ? path.basename(path.dirname(path.dirname(chrome))) : "playwright-default" };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

const editorUrl = (clipId) => `/projects/${JOB_ID}/clips/${clipId}/edit`;
const inspect = (page) => page.evaluate(() => {
  const hook = globalThis.__potonginEditorInspect;
  if (!hook) return null;
  const state = hook.state();
  const player = hook.player();
  return {
    status: state.status, save: state.save, etag: state.etag, revision: state.revision, pending: state.pending,
    commands: state.commands?.length ?? 0, doc: state.doc, seed: state.seed, otherTab: state.otherTab, conflict: state.conflict,
    player: player ? { mode: player.mode, frame: player.frame, exact: player.exact, presentedFrame: player.presentedFrame, pending: player.pending } : null,
  };
});

function contentOf(doc) {
  const { revision: _revision, parent_sha256: _parent, audit: _audit, ...rest } = doc;
  const canonical = (value) => (Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
      : JSON.stringify(value));
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

const transcript = (page) => page.locator('[data-panel="transcript"]');
const toolbar = (page) => page.getByRole("toolbar", { name: "Aksi kata" });

async function openTab(page, name) {
  await page.getByRole("tab", { name, exact: true }).click();
}

/** Indexes (data-w) of the words shown in the body zone, in order. */
async function bodyWordIndexes(page) {
  await openTab(page, "Transkrip");
  return transcript(page).locator('[data-w][data-zone="body"]:not([data-removed])')
    .evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("data-w"))));
}

const word = (page, index) => transcript(page).locator(`[data-w="${index}"]`);

async function selectRange(page, first, last) {
  await word(page, first).scrollIntoViewIfNeeded();
  await word(page, first).click();
  if (last !== first) {
    await word(page, last).scrollIntoViewIfNeeded();
    await word(page, last).click({ modifiers: ["Shift"] });
  }
}

async function resetToSeed(page) {
  const state = await inspect(page);
  if (state.seed && contentOf(state.doc) === contentOf(state.seed)) return;
  await page.getByRole("button", { name: "Kembali ke versi AI" }).click();
  await waitSaved(page);
}

async function wordsOf(page, state) {
  const url = `/api/jobs/${JOB_ID}/clips/${state.doc.clip_id}/words`;
  const response = await api(page, "GET", url);
  expect(response.status).toBe(200);
  return response.body.words;
}

/** Export through the dialog; resolves with the final RenderDTO and the dialog. */
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
  const link = dialog.getByRole("link", { name: "Unduh MP4" });
  await expect(link.or(dialog.getByRole("alert"))).toBeVisible({ timeout });
  if (!(await link.isVisible())) {
    throw new Error(`export failed: ${createdResponse.status()} ${JSON.stringify(first)} — ${await dialog.getByRole("alert").textContent()}`);
  }
  const doneMs = Date.now() - started;
  const polled = await api(page, "GET", `/api/jobs/${JOB_ID}/renders/${first.renderId}`);
  const final = polled.status === 200 ? polled.body : first;
  return { dialog, render: final, created: first, createdStatus: createdResponse.status(), doneMs };
}

async function download(page, dialog) {
  const waiting = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Unduh MP4" }).click();
  const file = await waiting;
  const target = path.join(mkdtempSync(path.join(os.tmpdir(), "editor-flow-")), file.suggestedFilename());
  await file.saveAs(target);
  return target;
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function verifyExport(doc, file) {
  const docFile = path.join(path.dirname(file), "doc.json");
  writeFileSync(docFile, JSON.stringify(doc));
  let out;
  try {
    out = execFileSync(PYTHON, [path.join(repoRoot, "scripts", "editor", "verify_export.py"), "--job-dir", path.join(JOBS_ROOT, JOB_ID),
      "--doc", docFile, "--file", file], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: "C.UTF-8" } });
  } catch (error) {
    out = error.stdout?.toString() ?? "{}";
  }
  return JSON.parse(out.trim().split("\n").at(-1));
}

function jobPath(apiUrl) {
  const prefix = `/api/jobs/${JOB_ID}/files/`;
  expect(apiUrl.startsWith(prefix)).toBeTruthy();
  return path.join(JOBS_ROOT, JOB_ID, ...apiUrl.slice(prefix.length).split("/").map(decodeURIComponent));
}

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page);
  const prepared = await api(page, "POST", `/api/jobs/${JOB_ID}/clips`, {});
  expect([200, 202], `POST /clips: ${prepared.status} ${JSON.stringify(prepared.body)}`).toContain(prepared.status);
  const listing = (await api(page, "GET", `/api/jobs/${JOB_ID}/clips`)).body;
  clips = listing.clips.filter((clip) => clip.openable && clip.clipId);
  expect(clips.length).toBeGreaterThan(0);
  await context.close();
});

test.beforeEach(async ({ page }) => {
  await login(page);
});

test("the editor page is cross-origin isolated, nosniff and never framed", async ({ page }) => {
  const response = await page.goto(editorUrl(clips[0].clipId));
  const headers = response.headers();
  expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
  expect(headers["cross-origin-embedder-policy"]).toBe("require-corp");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 60_000 });
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
});

test("the W2 flow: edit, undo/redo, reload, export, G1–G3, back to the AI version, R10", async ({ page, browser }) => {
  test.setTimeout(20 * 60_000);
  const clip = clips[1] ?? clips[0];
  const steps = [];
  const step = async (name, run) => {
    const started = Date.now();
    await run();
    steps.push({ name, ms: Date.now() - started });
  };
  await step("open", async () => { await openEditor(page, clip.clipId); });
  await resetToSeed(page);
  const seedState = await inspect(page);
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  let body = await bodyWordIndexes(page);
  expect(body.length).toBeGreaterThan(20);

  await step("trim", async () => {
    await selectRange(page, body[1], body[1]);
    await page.keyboard.press("i");
    await expect(word(page, body[0])).toHaveAttribute("data-zone", "before");
  });
  body = await bodyWordIndexes(page);
  await step("delete words", async () => {
    await selectRange(page, body[6], body[8]);
    await page.keyboard.press("Delete");
    await expect(transcript(page).locator("button[data-removal-id]")).toHaveCount(1);
  });
  body = await bodyWordIndexes(page);
  await step("fix a word", async () => {
    await word(page, body[10]).dblclick();
    const editor = transcript(page).locator("input[data-word-editor]");
    await expect(editor).toBeFocused();
    await editor.fill("Diperbaiki");
    await editor.press("Enter");
    await expect(word(page, body[10])).toHaveText("Diperbaiki");
  });
  await step("switch pack", async () => {
    await openTab(page, "Teks");
    const packs = page.getByRole("group", { name: "Gaya caption" });
    await packs.getByRole("radio", { name: "Bold" }).check();
    await expect(packs.getByRole("radio", { name: "Bold" })).toBeChecked();
  });
  await step("edit the hook", async () => {
    const hook = page.getByRole("textbox", { name: "Teks hook" });
    await hook.fill("Hook baru dari tes alur");
    await blur(page);
  });
  await step("change the cold open", async () => {
    await openTab(page, "Cold open");
    const panel = page.locator('[data-panel="coldopen"]');
    if (await panel.locator("[data-coldopen-line]").count()) {
      const before = await panel.locator("[data-coldopen-line]").textContent();
      await panel.getByRole("button", { name: "Buang kata terakhir" }).click();
      await expect(panel.locator("[data-coldopen-line]")).not.toHaveText(before);
    } else {
      const indexes = await bodyWordIndexes(page);
      await selectRange(page, indexes[20], indexes[26]);
      await page.keyboard.press("Control+Shift+H");
      await openTab(page, "Cold open");
      await expect(panel.locator("[data-coldopen-line]")).toHaveCount(1);
    }
  });
  const edited = await inspect(page);
  expect(contentOf(edited.doc)).not.toBe(contentOf(seedState.seed));
  expect(edited.doc.captions.pack.id).toBe("bold");
  expect(edited.doc.tracks.find((track) => track.kind === "hook").items[0].payload.text).toBe("Hook baru dari tes alur");

  await step("undo/redo", async () => {
    await blur(page);
    await page.keyboard.press("Control+z");
    await page.keyboard.press("Control+z");
    const undone = await inspect(page);
    expect(contentOf(undone.doc)).not.toBe(contentOf(edited.doc));
    expect(undone.doc.captions.pack.id).toBe("bold"); // two steps back: the cold open and the hook
    await page.keyboard.press("Control+Shift+z");
    await page.keyboard.press("Control+Shift+z");
    expect(contentOf((await inspect(page)).doc)).toBe(contentOf(edited.doc));
  });
  const saved = await waitSaved(page);
  expect(saved.revision).toBeGreaterThan(0);

  await step("reload", async () => {
    await page.reload();
    await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 60_000 });
  });
  const reloaded = await inspect(page);
  expect(reloaded.etag).toBe(saved.etag);
  expect(contentOf(reloaded.doc)).toBe(contentOf(edited.doc));
  await expect(word(page, body[10])).toHaveText("Diperbaiki");

  let exported;
  await step("export", async () => { exported = await exportClip(page); });
  expect(exported.render.state).toBe("completed");
  expect(exported.render.completedBy).toBe("render");
  let file;
  await step("download", async () => { file = await download(page, exported.dialog); });
  const verified = verifyExport(reloaded.doc, file);
  expect(verified.ok, JSON.stringify(verified)).toBe(true);
  await exported.dialog.getByRole("button", { name: "Tutup" }).click();

  await step("undo everything (back to the AI version)", async () => {
    await page.getByRole("button", { name: "Kembali ke versi AI" }).click();
    const reset = await waitSaved(page);
    expect(contentOf(reset.doc)).toBe(contentOf(reset.seed));
  });
  let auto;
  await step("export the AI version", async () => { auto = await exportClip(page, { timeout: 120_000 }); });
  expect(auto.render.state).toBe("completed");
  expect(auto.render.completedBy).toBe("seed");
  const autoFile = path.join(JOBS_ROOT, JOB_ID, "output", `clip-${String(clip.index).padStart(2, "0")}.mp4`);
  const exportPath = jobPath(auto.render.resultUrl);
  const exportStat = statSync(exportPath);
  const autoStat = statSync(autoFile);
  const r10File = await download(page, auto.dialog);
  const r10 = {
    sameInode: exportStat.ino === autoStat.ino && exportStat.dev === autoStat.dev,
    bytesEqual: sha256File(r10File) === sha256File(autoFile),
    completedBy: auto.render.completedBy,
    createdStatus: auto.createdStatus,
  };
  expect(r10.sameInode).toBe(true);
  expect(r10.bytesEqual).toBe(true);
  writeEvidence("T2.Z-e2e-flow", {
    schema: "potongin.gate/1", gate: "e2e flow (plan §11.2 T2.Z)", ...browserInfo(browser), clipDurationMs: clip.durationMs,
    steps, edited: { revision: saved.revision, renderMs: exported.doneMs, completedBy: exported.render.completedBy,
      verify: { ok: verified.ok, frames: verified.frames, samples: verified.samples,
        gates: verified.report?.gates?.map((gate) => ({ name: gate.name, ok: gate.ok, blocking: gate.blocking })) } },
    r10, pass: verified.ok && r10.sameInode && r10.bytesEqual,
  });
});

test("QG-CONFLICT: two tabs edit the same clip; both edits survive or the per-part dialog asks", async ({ browser }) => {
  test.setTimeout(5 * 60_000);
  const clip = clips[0];
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const a = await context.newPage();
  await login(a);
  await openEditor(a, clip.clipId);
  await resetToSeed(a);
  const b = await context.newPage();
  await openEditor(b, clip.clipId);
  await expect(a.getByText("Klip ini terbuka di tab lain")).toBeVisible();
  await expect(b.getByText("Klip ini terbuka di tab lain")).toBeVisible();

  // Different parts: A the hook text, B a caption word, saved at the same time → merged.
  await openTab(a, "Teks");
  await a.getByRole("textbox", { name: "Teks hook" }).fill("Hook dari tab A");
  await blur(a);
  const body = await bodyWordIndexes(b);
  await word(b, body[5]).dblclick();
  await transcript(b).locator("input[data-word-editor]").fill("TabB");
  await transcript(b).locator("input[data-word-editor]").press("Enter");
  await waitSaved(a);
  await waitSaved(b);
  const server = (await api(a, "GET", `/api/jobs/${JOB_ID}/clips/${clip.clipId}/edit`)).body;
  const hookText = server.doc.tracks.find((track) => track.kind === "hook").items[0].payload.text;
  const wordId = Object.keys(server.doc.captions.word_edits).find((id) => server.doc.captions.word_edits[id].text === "TabB");
  const merged = { hookText, wordEdited: Boolean(wordId) };
  expect(merged).toEqual({ hookText: "Hook dari tab A", wordEdited: true });

  // The same part: both change the hook text → B's save meets A's, the per-part dialog asks.
  await openTab(b, "Teks");
  await a.getByRole("textbox", { name: "Teks hook" }).fill("Hook A kedua");
  await blur(a);
  await waitSaved(a);
  await b.getByRole("textbox", { name: "Teks hook" }).fill("Hook B kedua");
  await blur(b);
  const dialog = b.getByRole("dialog", { name: "Klip ini diubah di tab lain" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog.getByText("Teks hook")).toBeVisible();
  await dialog.getByRole("button", { name: "Terapkan pilihan" }).click(); // "Pakai punyaku" is the default
  await waitSaved(b);
  const final = (await api(b, "GET", `/api/jobs/${JOB_ID}/clips/${clip.clipId}/edit`)).body;
  const finalHook = final.doc.tracks.find((track) => track.kind === "hook").items[0].payload.text;
  expect(finalHook).toBe("Hook B kedua");
  expect(Object.values(final.doc.captions.word_edits).some((edit) => edit.text === "TabB")).toBe(true);
  writeEvidence("T2.Z-QG-CONFLICT-e2e", {
    schema: "potongin.gate/1", gate: "QG-CONFLICT (two-tab e2e)", ...browserInfo(browser),
    differentParts: { merged: true, bothSurvive: merged.hookText === "Hook dari tab A" && merged.wordEdited },
    samePart: { dialog: true, chosen: "mine", finalIsMine: finalHook === "Hook B kedua", otherEditKept: true },
    pass: true,
  });
  await resetToSeed(b);
  await context.close();
});

test("QG-UX U1 (scripted): fix a clipped first word in ≤ 20 s", async ({ page, browser }) => {
  const clip = clips[0];
  await openEditor(page, clip.clipId);
  await resetToSeed(page);
  const body = await bodyWordIndexes(page);
  await selectRange(page, body[1], body[1]);
  await page.keyboard.press("i"); // the clipped start: the first word is outside the clip
  await waitSaved(page);
  const clippedId = (await inspect(page)).doc.main.segments.find((segment) => segment.role === "body");
  const started = Date.now();
  await openEditor(page, clip.clipId);
  await expect(word(page, body[0])).toHaveAttribute("data-zone", "before");
  await word(page, body[0]).scrollIntoViewIfNeeded();
  await word(page, body[0]).click();
  await toolbar(page).getByRole("button", { name: "Perpanjang ke sini" }).click();
  await expect(word(page, body[0])).toHaveAttribute("data-zone", "body");
  const state = await waitSaved(page);
  const elapsed = Date.now() - started;
  const bodySegment = state.doc.main.segments.find((segment) => segment.role === "body");
  expect(bodySegment.in_sf).toBeLessThan(clippedId.in_sf);
  writeEvidence("T2.Z-QG-UX-U1", { schema: "potongin.gate/1", gate: "QG-UX U1 (scripted, real stack)", ...browserInfo(browser),
    viewport: "1366x768", elapsedMs: elapsed, limitMs: U1_MS, pass: elapsed <= U1_MS });
  expect(elapsed).toBeLessThanOrEqual(U1_MS);
  await resetToSeed(page);
});

test("QG-UX U2 (scripted): remove a 5 s ramble via the transcript in ≤ 20 s", async ({ page, browser }) => {
  const clip = clips[0];
  await openEditor(page, clip.clipId);
  await resetToSeed(page);
  const state = await inspect(page);
  const words = await wordsOf(page, state);
  const body = await bodyWordIndexes(page);
  let range = null;
  for (let i = 2; i < body.length - 2 && !range; i += 1) {
    for (let j = i; j < body.length - 2; j += 1) {
      if (body[j] - body[i] !== j - i) break; // consecutive words only
      const span = words[body[j]].e - words[body[i]].s;
      if (span >= 5_000) { range = [body[i], body[j], span]; break; }
    }
  }
  expect(range).not.toBeNull();
  const started = Date.now();
  await openEditor(page, clip.clipId);
  await selectRange(page, range[0], range[1]);
  await page.keyboard.press("Delete");
  await expect(word(page, range[0])).toHaveAttribute("data-removed", /^rm_/);
  await waitSaved(page);
  const elapsed = Date.now() - started;
  writeEvidence("T2.Z-QG-UX-U2", { schema: "potongin.gate/1", gate: "QG-UX U2 (scripted, real stack)", ...browserInfo(browser),
    viewport: "1366x768", removedMs: range[2], words: range[1] - range[0] + 1, elapsedMs: elapsed, limitMs: U2_MS, pass: elapsed <= U2_MS });
  expect(elapsed).toBeLessThanOrEqual(U2_MS);
  await resetToSeed(page);
});

test("QG-UX U3 (scripted): replace the cold open in ≤ 45 s", async ({ page, browser }) => {
  const clip = clips[0];
  await openEditor(page, clip.clipId);
  await resetToSeed(page);
  const state = await inspect(page);
  const words = await wordsOf(page, state);
  const body = await bodyWordIndexes(page);
  let range = null;
  for (let i = Math.floor(body.length / 2); i < body.length - 2 && !range; i += 1) {
    for (let j = i; j < body.length - 2; j += 1) {
      if (body[j] - body[i] !== j - i) break;
      const span = words[body[j]].e - words[body[i]].s;
      if (span >= 2_000 && span <= 6_000) { range = [body[i], body[j], span]; break; }
      if (span > 6_000) break;
    }
  }
  expect(range).not.toBeNull();
  const started = Date.now();
  await openEditor(page, clip.clipId);
  await selectRange(page, range[0], range[1]);
  await toolbar(page).getByRole("button", { name: "Jadikan cold open" }).click();
  await expect(word(page, range[0])).toHaveAttribute("data-cold", "");
  const saved = await waitSaved(page);
  const elapsed = Date.now() - started;
  const coldOpen = saved.doc.main.segments.find((segment) => segment.role === "cold_open");
  expect(coldOpen).toBeTruthy();
  writeEvidence("T2.Z-QG-UX-U3", { schema: "potongin.gate/1", gate: "QG-UX U3 (scripted, real stack)", ...browserInfo(browser),
    viewport: "1366x768", coldOpenMs: range[2], elapsedMs: elapsed, limitMs: U3_MS, pass: elapsed <= U3_MS });
  expect(elapsed).toBeLessThanOrEqual(U3_MS);
  await resetToSeed(page);
});

test("QG-UX U6 (scripted): export and download in ≤ clip length + 30 s", async ({ page, browser }) => {
  test.setTimeout(15 * 60_000);
  const clip = clips[0];
  await openEditor(page, clip.clipId);
  await resetToSeed(page);
  await openTab(page, "Teks");
  await page.getByRole("textbox", { name: "Teks hook" }).fill(`Hook U6 ${Date.now() % 100000}`); // a new render key
  await blur(page);
  const state = await waitSaved(page);
  const limit = state.doc ? Math.round(Number(clip.durationMs)) + U6_EXTRA_MS : U6_EXTRA_MS;
  const started = Date.now();
  const exported = await exportClip(page);
  const file = await download(page, exported.dialog);
  const elapsed = Date.now() - started;
  expect(exported.render.completedBy).toBe("render");
  expect(statSync(file).size).toBeGreaterThan(0);
  writeEvidence("T2.Z-QG-UX-U6", { schema: "potongin.gate/1", gate: "QG-UX U6 (scripted, real stack, real render)", ...browserInfo(browser),
    viewport: "1366x768", clipDurationMs: clip.durationMs, renderMs: exported.doneMs, elapsedMs: elapsed, limitMs: limit,
    load: os.loadavg().map((value) => Math.round(value * 10) / 10), pass: elapsed <= limit });
  expect(elapsed).toBeLessThanOrEqual(limit);
  await exported.dialog.getByRole("button", { name: "Tutup" }).click();
  await resetToSeed(page);
});

test("QG-UX U7 (scripted): reload mid-edit loses nothing; 'Kembali ke versi AI' found in ≤ 20 s", async ({ page, browser }) => {
  const clip = clips[0];
  await openEditor(page, clip.clipId);
  await resetToSeed(page);
  await openTab(page, "Teks");
  await page.getByRole("textbox", { name: "Teks hook" }).fill("Hook sebelum muat ulang");
  await blur(page);
  const packs = page.getByRole("group", { name: "Gaya caption" });
  await packs.getByRole("radio", { name: "Box" }).check();
  const before = await inspect(page);
  expect(before.commands).toBeGreaterThan(0); // not saved yet: the reload comes before autosave
  await page.reload();
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 60_000 });
  const after = await waitSaved(page);
  const lost = contentOf(after.doc) === contentOf(before.doc) ? 0 : 1;
  expect(lost).toBe(0);
  const started = Date.now();
  await page.getByRole("button", { name: "Kembali ke versi AI" }).click();
  const reset = await waitSaved(page);
  const elapsed = Date.now() - started;
  expect(contentOf(reset.doc)).toBe(contentOf(reset.seed));
  writeEvidence("T2.Z-QG-UX-U7", { schema: "potongin.gate/1", gate: "QG-UX U7 (scripted, real stack)", ...browserInfo(browser),
    viewport: "1366x768", unsavedCommandsAtReload: before.commands, lostCommands: lost, resetFoundMs: elapsed, limitMs: U7_RESET_MS,
    pass: lost === 0 && elapsed <= U7_RESET_MS });
  expect(elapsed).toBeLessThanOrEqual(U7_RESET_MS);
});

test("PF-OPEN on the real stack: first visit ≤ 3.0 s, repeat ≤ 2.0 s (p95); first playhead cell ≤ 2.0 s after prepare", async ({ browser }) => {
  test.setTimeout(10 * 60_000);
  const runs = Number(process.env.EDITOR_PF_OPEN_RUNS || 10);
  const clip = clips[0];
  const first = [];
  const repeat = [];
  const shown = [];
  for (let run = 0; run < runs; run += 1) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 768 } });
    const page = await context.newPage();
    await login(page);
    first.push(await openEditor(page, clip.clipId));
    const started = Date.now();
    await page.reload();
    await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 60_000 });
    repeat.push(Date.now() - started);
    await expect.poll(async () => (await inspect(page))?.player?.presentedFrame ?? null, { timeout: 30_000 }).not.toBeNull();
    shown.push(Date.now() - started);
    await context.close();
  }
  // The first plate cell at the playhead after `prepare`, on a clip whose cells were never built.
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page);
  const fresh = clips.at(-1);
  const edit = (await api(page, "GET", `/api/jobs/${JOB_ID}/clips/${fresh.clipId}/edit`)).body;
  const prepareStarted = Date.now();
  const prepared = await api(page, "POST", `/api/jobs/${JOB_ID}/clips/${fresh.clipId}/prepare`, {});
  expect(prepared.status).toBe(202);
  const preparedBody = prepared.body;
  const afterPrepare = Date.now();
  let cellMs = null;
  let cellsBefore = preparedBody.plate?.ready ?? null;
  for (let attempt = 0; attempt < 200 && cellMs === null; attempt += 1) {
    const plan = (await api(page, "POST", `/api/jobs/${JOB_ID}/clips/${fresh.clipId}/preview/plan`, { doc: edit.doc, playhead: 0 })).body;
    const piece = plan.pieces[0];
    const k = Math.floor(piece.inSf / plan.plate.cellFrames);
    if (plan.plate.cells.find((cell) => cell.k === k)?.state === "ready") cellMs = Date.now() - afterPrepare;
    else await page.waitForTimeout(100);
  }
  await context.close();
  const result = {
    schema: "potongin.gate/1", gate: "PF-OPEN (real stack)", ...browserInfo(browser), viewport: "1366x768", runs,
    firstMs: { p50: percentile(first, 50), p95: percentile(first, 95), max: Math.max(...first) },
    repeatMs: { p50: percentile(repeat, 50), p95: percentile(repeat, 95), max: Math.max(...repeat) },
    repeatFrameOnStageMs: { p50: percentile(shown, 50), p95: percentile(shown, 95) },
    firstCellAfterPrepareMs: cellMs, prepareMs: afterPrepare - prepareStarted, cellsReadyBeforePlan: cellsBefore,
    limits: { firstMs: PF_OPEN_FIRST_MS, repeatMs: PF_OPEN_REPEAT_MS, cellMs: PF_OPEN_CELL_MS },
    load: os.loadavg().map((value) => Math.round(value * 10) / 10),
  };
  result.pass = result.firstMs.p95 <= PF_OPEN_FIRST_MS && result.repeatMs.p95 <= PF_OPEN_REPEAT_MS && cellMs !== null && cellMs <= PF_OPEN_CELL_MS;
  writeEvidence("T2.Z-PF-OPEN", result);
  expect(result.firstMs.p95).toBeLessThanOrEqual(PF_OPEN_FIRST_MS);
  expect(result.repeatMs.p95).toBeLessThanOrEqual(PF_OPEN_REPEAT_MS);
  expect(cellMs).not.toBeNull();
  expect(cellMs).toBeLessThanOrEqual(PF_OPEN_CELL_MS);
});

test("QG-A11Y on the real editor: axe finds no critical or serious violation", async ({ page, browser }) => {
  test.skip(!AXE, "set AXE_CORE_PATH to an axe.min.js (axe-core is not a web dependency)");
  const results = [];
  for (const viewport of [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await openEditor(page, clips[0].clipId);
    for (const [name, open] of [["ready", null], ["export dialog", async () => {
      await page.getByRole("button", { name: "Ekspor", exact: true }).click();
      await expect(page.getByRole("dialog", { name: "Ekspor klip" })).toBeVisible();
    }], ["text panel", async () => {
      await page.getByRole("dialog", { name: "Ekspor klip" }).getByRole("button", { name: "Tutup" }).click();
      await openTab(page, "Teks");
    }], ["cold-open panel", async () => { await openTab(page, "Cold open"); }]]) {
      if (open) await open();
      await page.addScriptTag({ content: AXE });
      const outcome = await page.evaluate(async () => {
        const report = await globalThis.axe.run(document, { resultTypes: ["violations"] });
        return report.violations.map((item) => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
      });
      results.push({ viewport: `${viewport.width}x${viewport.height}`, state: name, violations: outcome });
    }
  }
  const blocking = results.flatMap((entry) => entry.violations.filter((item) => ["critical", "serious"].includes(item.impact)));
  writeEvidence("T2.Z-QG-A11Y", { schema: "potongin.gate/1", gate: "QG-A11Y (real stack)", ...browserInfo(browser),
    axe: "4.13.0", states: results.length, critical: blocking.filter((item) => item.impact === "critical").length,
    serious: blocking.filter((item) => item.impact === "serious").length,
    anyImpact: results.reduce((sum, entry) => sum + entry.violations.length, 0), results, pass: blocking.length === 0 });
  expect(blocking).toEqual([]);
});
