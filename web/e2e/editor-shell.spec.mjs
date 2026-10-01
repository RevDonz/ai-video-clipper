// Editor V3 shell, stage, timeline and export (plan §11.2 T2.6, Appendix C, §6.1), plus the
// project-page entry. Runs against the T1.Z fakes (plan §11.0 "TDD protocol") until the W2
// integrator wires the real store, player and clients.
//
// Prerequisites:
//   - a server started with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1 (dev and CI only;
//     the Playwright webServer inherits both) and E2E_USERNAME/E2E_PASSWORD;
//   - E2E_EDITOR_FAKES=1 to run this file (it skips otherwise, with that reason);
//   - optional: AXE_CORE_PATH=<axe.min.js> for QG-A11Y (axe-core is not a dependency yet; the
//     test skips with that reason without it); EDITOR_GATES=1 for the PF-OPEN, U1 and U6 timing
//     runs; EDITOR_GATES_OUT=<dir> receives their JSON (numbers only).
// The browser is Chrome for Testing 147.0.7727.15 (Playwright build 1217) when installed, as in
// web/e2e/parity-text.spec.mjs; EDITOR_CHROME overrides the executable.
import { expect, test as base } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../components/editor/__dev__/fakes.mjs";
import { login, settings } from "./support/harness.mjs";

const EDITOR = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit`;
const AUTO_RENDER = `/api/jobs/${FAKE_JOB_ID}/files/output/clip-01.mp4`;
const EXPORT_MP4 = `/api/jobs/${FAKE_JOB_ID}/files/output/edits/${FAKE_CLIP_ID}/0123456789abcdef.mp4`;
const EXPORT_SRT = `/api/jobs/${FAKE_JOB_ID}/files/output/edits/${FAKE_CLIP_ID}/0123456789abcdef.srt`;
const HELP_TEXT = "Frame, teks, logo dan audio sama dengan hasil akhir. File MP4 akhir dikompresi (H.264, warna 4:2:0), "
  + "jadi tepi teks berwarna sedikit lebih lembut. Tekan 'Frame akhir' untuk melihat piksel persisnya.";
const gatesOut = process.env.EDITOR_GATES_OUT || "";
const runGates = process.env.EDITOR_GATES === "1";

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

const chrome = process.env.EDITOR_CHROME || defaultChrome();
const AXE = axeSource();

function writeGate(name, value) {
  if (!gatesOut) return;
  mkdirSync(gatesOut, { recursive: true });
  writeFileSync(path.join(gatesOut, name), `${JSON.stringify(value, null, 2)}\n`);
}

// A small real MP4 for the auto render and the export download (made at run time; no media in git).
let tinyMp4 = Buffer.alloc(0);
function makeTinyMp4() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "potongin-editor-shell-"));
  const out = path.join(dir, "tiny.mp4");
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=720x1280:d=1:r=30",
      "-threads", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast", "-movflags", "+faststart", "-y", out]);
    return readFileSync(out);
  } catch {
    return Buffer.alloc(0);
  }
}

// ---------------------------------------------------------------------------------------------
// Browser-side scenario (serialised by addInitScript; self-contained). The editor's fake runtime
// passes each fake object through window.__potonginEditorScenario hooks.
function installScenario(config) {
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const calls = [];
  window.__scenarioCalls = calls;
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const bodyOf = (doc) => doc.main.segments.find((segment) => segment.role === "body");

  function withLatency(object, table) {
    const out = { ...object };
    for (const [name, ms] of Object.entries(table || {})) {
      const inner = out[name];
      out[name] = async (...args) => { await wait(ms); return inner(...args); };
    }
    return out;
  }

  function renderSimulation(api, fakes) {
    const renders = new Map();
    const spec = config.render;
    let count = 0;
    const dto = (id, fields) => ({ renderId: id, clipId: fakes.FAKE_CLIP_ID, state: "queued", stage: "antre", progressPm: 0,
      revision: renders.get(id)?.revision ?? 0, errorCode: null, resultUrl: null, srtUrl: null, ...fields });
    const at = (id) => {
      const render = renders.get(id);
      if (render.cancelled) return dto(id, { state: "cancelled", stage: render.lastStage, errorCode: "cancelled" });
      const elapsed = Date.now() - render.t0;
      const queueMs = spec.queueMs ?? 300;
      const renderMs = spec.renderMs ?? 1500;
      const verifyMs = spec.verifyMs ?? 300;
      if (elapsed < queueMs) return dto(id, { state: "queued", stage: "antre" });
      if (elapsed < queueMs + renderMs) {
        render.lastStage = "merender";
        return dto(id, { state: "rendering", stage: "merender", progressPm: Math.floor(((elapsed - queueMs) / renderMs) * 1000) });
      }
      if (elapsed < queueMs + renderMs + verifyMs) {
        render.lastStage = "memverifikasi";
        return dto(id, { state: "rendering", stage: "memverifikasi", progressPm: 1000 });
      }
      if (spec.outcome === "verification_failed" && render.attempt === 1) {
        return dto(id, { state: "failed", stage: "memverifikasi", progressPm: 1000, errorCode: "verification_failed" });
      }
      return dto(id, { state: "completed", stage: "selesai", progressPm: 1000, resultUrl: spec.resultUrl, srtUrl: spec.srtUrl });
    };
    return {
      ...api,
      async createRender(body, key) {
        calls.push(["createRender", body, key]);
        if (spec.instant) {
          return dto("render-instant", { state: "completed", stage: "selesai", progressPm: 1000, resultUrl: spec.resultUrl, srtUrl: spec.srtUrl });
        }
        count += 1;
        const id = `render-${count}`;
        renders.set(id, { t0: Date.now(), attempt: count, cancelled: false, lastStage: "antre", revision: 1 });
        return dto(id, { state: "queued", stage: "antre" });
      },
      async getRender(id) { calls.push(["getRender", id]); return at(id); },
      async cancelRender(id) {
        calls.push(["cancelRender", id]);
        renders.get(id).cancelled = true;
        return at(id);
      },
    };
  }

  function scenarioStore(fakes, parts) {
    const listeners = new Set();
    const past = [];
    const future = [];
    let planSeq = 0;
    let saveTimer = null;
    let state = { status: "loading", doc: null, seed: null, words: null, etag: null, revision: null, save: "saved", savedAtMs: null,
      canUndo: false, canRedo: false, plan: null, pending: config.pending ?? [], warnings: config.warnings ?? [],
      selection: null, commands: [], conflict: null, readOnlyReason: null };
    const set = (patch) => {
      state = { ...state, ...patch, canUndo: past.length > 0, canRedo: future.length > 0 };
      for (const listener of [...listeners]) listener(state);
    };
    const replan = async (doc) => {
      const seq = ++planSeq;
      const plan = await parts.previewClient.plan(doc);
      if (seq === planSeq) set({ plan });
    };
    const store = {
      getState: () => state,
      dispatch(type, args = {}, options = {}) {
        if (!fakes.COMMANDS.includes(type)) throw new fakes.CommandRejected("unknown_command");
        if (state.status !== "ready") throw new fakes.CommandRejected("read_only");
        const next = clone(state.doc);
        if (type === "TrimStart") {
          const bound = state.words.bounds.find((entry) => entry.before === args.gapWord);
          if (!bound) throw new fakes.CommandRejected("unknown_word");
          bodyOf(next).in_sf = bound.sf;
        } else if (type === "TrimEnd") {
          const bound = state.words.bounds.find((entry) => entry.after === args.gapWord);
          if (!bound) throw new fakes.CommandRejected("unknown_word");
          bodyOf(next).out_sf = bound.sf;
        } else if (type === "SetHookDuration") {
          next.tracks.find((track) => track.kind === "hook").items[0].dur_f = args.dur_f;
        } else if (type === "SetCaptionsEnabled") {
          next.captions.enabled = Boolean(args.on);
        } else if (type === "ResetToSeed") {
          const seed = clone(state.seed ?? next);
          for (const key of Object.keys(seed)) if (!["revision", "parent_sha256", "audit", "base"].includes(key)) next[key] = seed[key];
        }
        next.audit.last_command = type;
        past.push(state.doc);
        future.length = 0;
        set({ doc: next, save: "dirty", commands: [...state.commands, { type, args, mergeKey: options.mergeKey ?? null }] });
        replan(next);
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => { store.flush(); }, config.autosaveMs ?? 1500);
        return next;
      },
      undo() {
        if (!past.length) return;
        future.push(state.doc);
        const doc = past.pop();
        set({ doc, save: "dirty" });
        replan(doc);
      },
      redo() {
        if (!future.length) return;
        past.push(state.doc);
        const doc = future.pop();
        set({ doc, save: "dirty" });
        replan(doc);
      },
      async flush() {
        clearTimeout(saveTimer);
        if (state.save !== "dirty") return;
        set({ save: "saving" });
        await wait(config.saveMs ?? 60);
        if (config.saveFails) { set({ save: "error" }); return; }
        // As the real store: the saved revision is `revision`; `doc` keeps the session document.
        const next = { ...state.doc, revision: state.revision + 1, parent_sha256: state.etag };
        const result = await parts.api.putEdit(next, { etag: state.etag, key: crypto.randomUUID() });
        set({ save: "saved", savedAtMs: Date.now(), etag: result.etag, revision: result.doc.revision });
      },
      resolveConflict(choices) {
        calls.push(["resolveConflict", choices]);
        set({ conflict: null, save: "dirty" });
      },
      startFromSeed() {
        calls.push(["startFromSeed"]);
        set({ status: "ready", readOnlyReason: null });
      },
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      destroy() { listeners.clear(); clearTimeout(saveTimer); },
    };
    (async () => {
      const edit = await parts.api.getEdit({ seed: false });
      const words = await parts.api.words(edit.words.url);
      const plan = await parts.previewClient.plan(edit.doc);
      set({ status: edit.readOnly ? "readOnly" : "ready", readOnlyReason: edit.readOnlyReason ?? null, doc: edit.doc,
        seed: clone(edit.doc), words, etag: edit.etag, revision: edit.doc.revision, plan, savedAtMs: Date.now() });
      if (config.conflict) set({ save: "conflict", conflict: config.conflict });
    })();
    return store;
  }

  window.__potonginEditorScenario = {
    pollMs: config.pollMs,
    api(api, fakes) {
      let out = api;
      if (config.docPatch) {
        const doc = fakes.fakeDoc();
        for (const [pathText, value] of Object.entries(config.docPatch)) {
          const keys = pathText.split(".");
          let target = doc;
          for (const key of keys.slice(0, -1)) target = target[key];
          target[keys.at(-1)] = value;
        }
        out = fakes.createFakeApiClient({ doc });
      }
      if (config.render) out = renderSimulation(out, fakes);
      if (config.readOnly) {
        const getEdit = out.getEdit;
        out = { ...out, getEdit: async (options) => ({ ...(await getEdit(options)), readOnly: true, readOnlyReason: config.readOnly }) };
      }
      if (config.latency?.api) out = withLatency(out, config.latency.api);
      return out;
    },
    previewClient(client) {
      const plan = async (doc) => {
        const dto = await client.plan(doc);
        if (config.rev0Exact) {
          const seedSha = dto.rev0.planSha256;
          dto.rev0 = { planSha256: seedSha, autoRenderUrl: config.autoRenderUrl, exact: doc.revision === 0 || dto.planSha256 === seedSha };
          if (doc.revision === 0) dto.planSha256 = seedSha;
        }
        if (config.planWarnings) dto.warnings = config.planWarnings;
        if (config.cells) dto.plate = { ...dto.plate, cells: config.cells };
        if (config.unchanged) dto.rev0 = { ...dto.rev0, planSha256: dto.planSha256 };
        return dto;
      };
      return withLatency({ ...client, plan }, config.latency?.preview);
    },
    store(store, fakes, parts) {
      if (!config.scenarioStore) return store;
      store.destroy();
      return scenarioStore(fakes, parts);
    },
    player(player, fakes, options) {
      if (!config.rev0Exact && !config.unsupported) return player;
      let auto = false;
      const emit = (mode) => options.onState({ ...player.state(), mode, playing: false });
      return {
        ...player,
        load(plan) {
          player.load(plan);
          if (config.unsupported) { emit("unsupported"); return; }
          auto = Boolean(plan?.rev0?.exact);
          // The player owns the <video>'s src (T2.4; the Stage no longer sets it, T2.Z patch 28).
          if (auto && options.video && options.video.getAttribute("src") !== plan.rev0.autoRenderUrl) {
            options.video.setAttribute("src", plan.rev0.autoRenderUrl);
          }
          if (auto) emit("auto_render");
        },
        state() {
          const current = player.state();
          if (config.unsupported) return { ...current, mode: "unsupported" };
          return auto && current.mode === "live" ? { ...current, mode: "auto_render" } : current;
        },
        async seek(frame) { await player.seek(frame); if (auto) emit("auto_render"); },
        async showTruthFrame(frame) { auto = false; return player.showTruthFrame(frame); },
      };
    },
  };

  // PF-OPEN: the moment the editor is interactive (store ready, stage loaded, transcript panel shown).
  const observer = new MutationObserver(() => {
    if (window.__openMs !== undefined) return;
    if (document.querySelector('[data-editor-ready="true"]') && document.querySelector('[data-panel="transcript"]')) {
      window.__openMs = performance.now();
      observer.disconnect();
    }
  });
  observer.observe(document, { childList: true, subtree: true, attributes: true });
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
    page.allowConsole = [];
    await page.route(`**${AUTO_RENDER}`, (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: tinyMp4 }));
    await page.route(`**/files/output/edits/**`, (route) => route.fulfill({
      status: 200, body: route.request().url().endsWith(".srt") ? "1\n00:00:00,000 --> 00:00:01,000\nhalo\n" : tinyMp4,
      headers: { "Content-Type": route.request().url().endsWith(".srt") ? "application/x-subrip" : "video/mp4",
        "Content-Disposition": "attachment; filename=\"klip.mp4\"" },
    }));
    await use(page);
    failures.console = failures.console.filter((text) => !page.allowConsole.some((pattern) => pattern.test(text)));
    const count = Object.values(failures).reduce((total, list) => total + list.length, 0);
    if (count) {
      if (testInfo.status === testInfo.expectedStatus) throw new Error(`Browser diagnostics:\n${JSON.stringify(failures, null, 2)}`);
      process.stderr.write(`Browser diagnostics for ${testInfo.title}:\n${JSON.stringify(failures, null, 2)}\n`);
    }
  },
});

test.use({
  launchOptions: chrome ? { executablePath: chrome } : {},
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

test.beforeAll(() => {
  if (!tinyMp4.length) tinyMp4 = makeTinyMp4();
});

async function openEditor(page, config = null, { path: target = EDITOR } = {}) {
  if (config) await page.addInitScript(installScenario, config);
  await page.goto(target);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
}

const editorState = (page) => page.evaluate(() => {
  const state = window.__potonginEditor.store.getState();
  return { status: state.status, save: state.save, doc: state.doc, revision: state.revision, commands: state.commands ?? [], plan: state.plan };
});
const playerFrame = (page) => page.evaluate(() => window.__potonginEditor.player.frame());
const scenarioCalls = (page) => page.evaluate(() => window.__scenarioCalls ?? []);
const badge = (page) => page.getByTestId("stage-badge");
const timeText = (page) => page.getByTestId("stage-time");

// ---------------------------------------------------------------------------------------------
// Stage and badge (§6.1)

test("the untouched T1.Z fakes open the editor live with every layer current", async ({ page }) => {
  await openEditor(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sutradara ditahan security");
  await expect(badge(page)).toHaveText("● Sesuai hasil akhir");
  await expect(page.getByRole("img", { name: "Pratinjau klip" })).toBeVisible();
  await expect(page.locator('video[data-stage="auto-render"]')).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: /^Tersimpan/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "← Proyek" })).toHaveAttribute("href", `/projects/${FAKE_JOB_ID}`);
  await expect(timeText(page)).toHaveText("00:00,0 / 00:10,0");
  await expect(page.getByRole("tab", { name: "Transkrip" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-lane="video"] [data-piece-role="body"]')).toHaveCount(1);
  await expect(page.locator('[data-lane="captions"] [data-cue]')).toHaveCount(3);
  await expect(page.locator('[data-lane="hook"] [data-hook-block]')).toContainText("Kenapa sutradara ditahan di film sendiri?");
});

test("opening revision 0 shows the auto render and '● Sesuai hasil akhir'; the help popover text", async ({ page }) => {
  await openEditor(page, { rev0Exact: true, autoRenderUrl: AUTO_RENDER });
  const video = page.locator('video[data-stage="auto-render"]');
  await expect(video).toBeVisible();
  await expect(video).toHaveAttribute("src", AUTO_RENDER);
  await expect(page.getByRole("img", { name: "Pratinjau klip" })).toBeHidden();
  await expect(badge(page)).toHaveText("● Sesuai hasil akhir");
  await expect(page.getByText("Memutar klip otomatis (identik)")).toBeVisible();
  const help = page.getByRole("button", { name: "Apa artinya?" });
  await expect(help).toHaveAttribute("aria-expanded", "false");
  await help.click();
  await expect(help).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("note")).toHaveText(HELP_TEXT);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(help).toBeFocused();
});

test("a pending layer replaces the badge with what is pending, never an approximate claim", async ({ page }) => {
  // The body covers source-grid frames [37215, 37515): cells 620–625 of 60 frames.
  const cells = [{ k: 620, state: "ready", url: "/c620.mp4" }, { k: 621, state: "ready", url: "/c621.mp4" },
    { k: 622, state: "building" }, { k: 623, state: "queued" }, { k: 624, state: "queued" }, { k: 625, state: "queued" }];
  await openEditor(page, { scenarioStore: true, pending: ["text", "plate"], cells });
  await expect(badge(page)).toHaveText("Memperbarui teks… · Menyiapkan video (2/6)…");
  await expect(page.getByText("● Sesuai hasil akhir")).toHaveCount(0);
  await page.getByRole("button", { name: "Apa artinya?" }).click();
  await expect(page.getByRole("note")).not.toHaveText(HELP_TEXT);
  await expect(page.getByRole("note")).toContainText("belum");
  await page.keyboard.press("Escape");
  const px = await pxPerFrame(page);
  const band = await page.locator("[data-pending-band]").evaluateAll((elements) => elements.map((element) => [element.offsetLeft, element.offsetWidth]));
  expect(band).toHaveLength(1);
  // Cells 622–625 cover [37320, 37560): output frames [105, 300) of the 300-frame body.
  expect(Math.abs(band[0][0] - 105 * px)).toBeLessThanOrEqual(1);
  expect(Math.abs(band[0][1] - 195 * px)).toBeLessThanOrEqual(1);
});

test("an unsupported browser keeps editing and export, with the §C.6 notice", async ({ page }) => {
  await openEditor(page, { unsupported: true });
  await expect(badge(page)).toHaveText("Pratinjau langsung butuh Chrome/Edge desktop. Anda tetap bisa mengedit dan mengekspor.");
  await expect(page.getByRole("button", { name: "Ekspor", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Frame akhir" })).toBeEnabled();
});

// ---------------------------------------------------------------------------------------------
// Timeline (Appendix C.3)

async function pxPerFrame(page) {
  return Number(await page.getByRole("region", { name: "Timeline" }).getAttribute("data-px-per-frame"));
}

async function dragBy(page, locator, dx, { alt = false, beforeUp = null } = {}) {
  const box = await locator.boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  if (alt) await page.keyboard.down("Alt");
  await page.mouse.move(x + dx / 2, y, { steps: 3 });
  await page.mouse.move(x + dx, y, { steps: 3 });
  if (beforeUp) await beforeUp();
  await page.mouse.up();
  if (alt) await page.keyboard.up("Alt");
}

test("trim drag snaps to bounds; Alt only frees the ghost, the stored value stays a bounds frame", async ({ page }) => {
  // Seed body [37225, 37515): the first word ("Kenapa", 37220.7…) is clipped; bounds 37220 | 37229 | …
  await openEditor(page, { scenarioStore: true, docPatch: { "main.segments.0.in_sf": 37225 } });
  const px = await pxPerFrame(page);
  const start = page.getByRole("slider", { name: "Awal klip" });
  await expect(start).toHaveAttribute("aria-valuenow", "37225");
  await dragBy(page, start, -4 * px, {
    beforeUp: async () => {
      await expect(page.locator("[data-trim-ghost]")).toHaveAttribute("data-snapped", "true");
      await expect(page.locator("[data-trim-ghost]")).toHaveAttribute("data-sf", "37220");
    },
  });
  await expect.poll(async () => (await editorState(page)).commands.at(-1)).toEqual({ type: "TrimStart", args: { gapWord: "w048121" }, mergeKey: null });
  await expect(start).toHaveAttribute("aria-valuenow", "37220");

  const end = page.getByRole("slider", { name: "Akhir klip" });
  const endBefore = Number(await end.getAttribute("aria-valuenow"));
  await dragBy(page, end, -7 * px, {
    alt: true,
    beforeUp: async () => {
      await expect(page.locator("[data-trim-ghost]")).toHaveAttribute("data-snapped", "false");
      await expect(page.locator("[data-trim-ghost]")).toHaveAttribute("data-sf", String(endBefore - 7));
    },
  });
  const state = await editorState(page);
  const last = state.commands.at(-1);
  expect(last.type).toBe("TrimEnd");
  const words = await page.evaluate(() => window.__potonginEditor.store.getState().words);
  const bound = words.bounds.find((entry) => entry.after === last.args.gapWord);
  expect(bound).toBeTruthy();
  expect(state.doc.main.segments[0].out_sf).toBe(bound.sf);
  expect(Math.abs(bound.sf - (endBefore - 7))).toBeLessThanOrEqual(
    Math.min(...words.bounds.filter((entry) => entry.after).map((entry) => Math.abs(entry.sf - (endBefore - 7))))
  );
});

test("trim handles and the hook duration work from the keyboard", async ({ page }) => {
  await openEditor(page, { scenarioStore: true, docPatch: { "main.segments.0.in_sf": 37225 } });
  const start = page.getByRole("slider", { name: "Awal klip" });
  await start.focus();
  await page.keyboard.press("ArrowLeft");
  await expect.poll(async () => (await editorState(page)).commands.at(-1)?.args).toEqual({ gapWord: "w048121" });
  await expect(start).toHaveAttribute("aria-valuenow", "37220");
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await editorState(page)).commands.at(-1)?.args).toEqual({ gapWord: "w048122" });
  expect(await playerFrame(page)).toBe(0);

  const hook = page.getByRole("slider", { name: "Durasi hook" });
  await expect(hook).toHaveAttribute("aria-valuenow", "120");
  await hook.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(async () => (await editorState(page)).commands.at(-1)).toEqual(
    { type: "SetHookDuration", args: { dur_f: 121 }, mergeKey: "hook:dur_f" });
  await page.keyboard.press("Shift+ArrowLeft");
  await expect.poll(async () => (await editorState(page)).commands.at(-1)?.args).toEqual({ dur_f: 91 });
  await expect(hook).toHaveAttribute("aria-valuetext", "3,0 dtk");
});

test("the hook duration handle drags on the frame grid", async ({ page }) => {
  await openEditor(page, { scenarioStore: true });
  const px = await pxPerFrame(page);
  await dragBy(page, page.getByRole("slider", { name: "Durasi hook" }), 30 * px);
  await expect.poll(async () => (await editorState(page)).commands.at(-1)).toEqual(
    { type: "SetHookDuration", args: { dur_f: 150 }, mergeKey: null });
});

test("clicking the ruler seeks and the playhead follows", async ({ page }) => {
  await openEditor(page);
  const px = await pxPerFrame(page);
  const ruler = page.getByRole("slider", { name: "Posisi pemutaran" });
  const box = await ruler.boundingBox();
  await page.mouse.click(box.x + 60 * px + 0.5 * px, box.y + box.height / 2);
  await expect.poll(() => playerFrame(page)).toBe(60);
  await expect(timeText(page)).toHaveText("00:02,0 / 00:10,0");
  await expect(ruler).toHaveAttribute("aria-valuenow", "60");
  const playhead = page.locator("[data-playhead]");
  const left = await playhead.evaluate((element) => element.getBoundingClientRect().left);
  expect(Math.abs(left - (box.x + 60 * px))).toBeLessThanOrEqual(1.5);
});

// ---------------------------------------------------------------------------------------------
// Shortcuts (Appendix C.4)

test("shortcuts drive playback, undo/redo, the safe zone, truth frame, export and help", async ({ page }) => {
  await openEditor(page);
  const play = page.getByRole("button", { name: "Putar" });
  await page.locator("body").click({ position: { x: 5, y: 1075 } });
  await page.keyboard.press(" ");
  await expect(page.getByRole("button", { name: "Jeda" })).toBeVisible();
  await page.keyboard.press("k");
  await expect(play).toBeVisible();

  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  expect(await playerFrame(page)).toBe(2);
  await page.keyboard.press("Shift+ArrowRight");
  expect(await playerFrame(page)).toBe(32);
  await expect(timeText(page)).toHaveText("00:01,0 / 00:10,0");
  await page.keyboard.press("ArrowLeft");
  expect(await playerFrame(page)).toBe(31);

  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  await page.keyboard.press("Control+z");
  expect((await editorState(page)).doc.captions.enabled).toBe(true);
  await page.keyboard.press("Control+Shift+Z");
  expect((await editorState(page)).doc.captions.enabled).toBe(false);
  await page.keyboard.press("Control+z");
  await page.keyboard.press("Control+y");
  expect((await editorState(page)).doc.captions.enabled).toBe(false);

  await page.keyboard.press("'");
  await expect(page.locator("[data-safe-zone]")).toBeVisible();
  await expect(page.getByRole("button", { name: "Zona aman" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("'");
  await expect(page.locator("[data-safe-zone]")).toHaveCount(0);

  await page.keyboard.press("Control+Shift+R");
  await expect(badge(page)).toHaveText("● Frame akhir");
  await expect(page.getByRole("button", { name: "Frame akhir" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Control+Shift+R");
  await expect(badge(page)).toHaveText("● Sesuai hasil akhir");

  await page.keyboard.press("Control+Shift+E");
  await expect(page.getByRole("dialog", { name: "Ekspor klip" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Ekspor klip" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Ekspor", exact: true })).toBeFocused();

  await page.keyboard.press("?");
  const helpDialog = page.getByRole("dialog", { name: "Pintasan keyboard" });
  await expect(helpDialog).toBeVisible();
  await expect(helpDialog.getByText("Ctrl+Shift+R")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(helpDialog).toHaveCount(0);
});

test("typing in a field never triggers editor shortcuts", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.setAttribute("aria-label", "Uji ketik");
    input.id = "typing-probe";
    document.querySelector("[data-editor-root]").prepend(input);
  });
  await page.locator("#typing-probe").focus();
  await page.keyboard.type("k i o '");
  await page.keyboard.press("ArrowRight");
  expect(await playerFrame(page)).toBe(0);
  await expect(page.getByRole("button", { name: "Putar" })).toBeVisible();
  await expect(page.locator("[data-safe-zone]")).toHaveCount(0);
  expect((await editorState(page)).commands).toEqual([]);
});

test("I and O trim at the playhead to the word under it", async ({ page }) => {
  await openEditor(page, { scenarioStore: true });
  await page.evaluate(() => window.__potonginEditor.player.seek(45));
  await page.locator("body").click({ position: { x: 5, y: 1075 } });
  await page.keyboard.press("i");
  const state = await editorState(page);
  expect(state.commands.at(-1).type).toBe("TrimStart");
  expect(state.commands.at(-1).args.gapWord).toMatch(/^w\d{6}$/);
});

// ---------------------------------------------------------------------------------------------
// Checks, conflicts, read-only (Appendix C.1, C.6, §4.5)

test("the checks panel lists warnings with their messages and jumps to their frame", async ({ page }) => {
  await openEditor(page, { planWarnings: [{ code: "tight_cut", ref: "rm_01", f: 120 }, { code: "hook_overflow", ref: "it_hook", f: 0 }] });
  const open = page.getByRole("button", { name: "Perlu dicek (2)" });
  await open.click();
  const panel = page.getByRole("dialog", { name: "Perlu dicek" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("listitem")).toHaveCount(2);
  await expect(panel.getByRole("listitem").first()).toContainText("Teks hook terlalu panjang");
  await panel.getByRole("button", { name: "Lihat di 00:04,0" }).click();
  await expect.poll(() => playerFrame(page)).toBe(120);
  await expect(timeText(page)).toHaveText("00:04,0 / 00:10,0");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(open).toBeFocused();
});

test("the conflict dialog asks per part and resolves with the choices", async ({ page }) => {
  await openEditor(page, { scenarioStore: true, conflict: { parts: [
    { id: "hook", label: "Teks hook" }, { id: "rm_01", label: "Potongan 00:12" }, { id: "w048121", label: "Caption kata 'Kenapa'" },
  ] } });
  const dialog = page.getByRole("dialog", { name: "Klip ini diubah di tab lain" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveText("Konflik");
  await expect(dialog.getByRole("group")).toHaveCount(3);
  await dialog.getByRole("group", { name: "Potongan 00:12" }).getByRole("radio", { name: "Pakai yang tersimpan" }).check();
  await dialog.getByRole("button", { name: "Terapkan pilihan" }).click();
  await expect(dialog).toHaveCount(0);
  expect(await scenarioCalls(page)).toContainEqual(["resolveConflict", { hook: "mine", rm_01: "theirs", w048121: "mine" }]);
});

test("a changed transcript opens read-only with 'Mulai dari versi AI'", async ({ page }) => {
  await openEditor(page, { scenarioStore: true, readOnly: "transcript_changed" });
  await expect(page.getByText("Transkrip berubah sejak klip diedit")).toBeVisible();
  await expect(page.getByRole("slider", { name: "Awal klip" })).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByRole("button", { name: "Ekspor", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Mulai dari versi AI" }).click();
  expect(await scenarioCalls(page)).toContainEqual(["startFromSeed"]);
  await expect(page.getByText("Transkrip berubah sejak klip diedit")).toHaveCount(0);
});

test("a clip whose auto file came before the editor says so; save errors offer a retry", async ({ page }) => {
  await openEditor(page, { scenarioStore: true, saveFails: true, autosaveMs: 50, docPatch: { "base.engine.compiler": "legacy" } });
  await expect(page.getByText("Klip otomatis ini dibuat sebelum editor dibuka; setelah klip diubah, tampilan teks hasil ekspor bisa sedikit berbeda")).toBeVisible();
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  await expect(page.getByRole("status").filter({ hasText: "Gagal menyimpan; perubahan aman di browser ini" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Coba simpan lagi" })).toBeVisible();
});

test("'Kembali ke versi AI' is one visible, undoable command", async ({ page }) => {
  await openEditor(page, { scenarioStore: true });
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  await page.getByRole("button", { name: "Kembali ke versi AI" }).click();
  const state = await editorState(page);
  expect(state.commands.at(-1).type).toBe("ResetToSeed");
  expect(state.doc.captions.enabled).toBe(true);
  await page.getByRole("button", { name: "Urungkan" }).click();
  expect((await editorState(page)).doc.captions.enabled).toBe(false);
});

// ---------------------------------------------------------------------------------------------
// Export dialog (Appendix C.5)

const RENDER = { queueMs: 300, renderMs: 1500, verifyMs: 600, resultUrl: EXPORT_MP4, srtUrl: EXPORT_SRT };

async function startExport(page) {
  await page.getByRole("button", { name: "Ekspor", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Ekspor klip" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("export: acknowledge each check, then Antre → Merender (n%) → Memverifikasi → Selesai with downloads", async ({ page }) => {
  await openEditor(page, { scenarioStore: true, pollMs: 200, render: RENDER,
    planWarnings: [{ code: "tight_cut", ref: "rm_01", f: 120 }, { code: "peak_reduced:-3.80 dB", ref: null, f: null }] });
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  const dialog = await startExport(page);
  await expect(dialog.getByText("720×1280, kualitas sama dengan klip otomatis")).toBeVisible();
  await expect(dialog.getByText("Tanpa perubahan: file klip otomatis dipakai langsung")).toHaveCount(0);
  const start = dialog.getByRole("button", { name: "Mulai ekspor" });
  await expect(start).toBeDisabled();
  const acks = dialog.getByRole("checkbox");
  await expect(acks).toHaveCount(2);
  await acks.nth(0).check();
  await expect(start).toBeDisabled();
  await acks.nth(1).check();
  await start.click();
  const steps = dialog.getByRole("list", { name: "Tahap ekspor" });
  await expect(steps.locator('[aria-current="step"]')).toHaveText(/Antre|Merender/);
  await expect(steps.locator('[aria-current="step"]')).toHaveText(/Merender \(\d{1,2}%\)/);
  await expect(dialog.getByRole("button", { name: "Batalkan ekspor" })).toBeVisible();
  await expect(steps.locator('[aria-current="step"]')).toHaveText("Memverifikasi");
  await expect(dialog.getByRole("link", { name: "Unduh MP4" })).toHaveAttribute("href", EXPORT_MP4, { timeout: 10_000 });
  await expect(dialog.getByRole("link", { name: "Unduh SRT" })).toHaveAttribute("href", EXPORT_SRT);
  await expect(dialog.getByRole("button", { name: "Batalkan ekspor" })).toHaveCount(0);
  const calls = await scenarioCalls(page);
  const state = await editorState(page);
  expect(state.save).toBe("saved");
  expect(calls.find((call) => call[0] === "createRender")[1]).toEqual({ editEtag: expect.stringMatching(/^[0-9a-f]{64}$/) });
  // the revision the export was made from (the store's saved one; the loaded document is 0)
  await expect(dialog.getByText("Revisi 1 · tersimpan")).toBeVisible();
  await expect(dialog.getByText("Volume diturunkan agar audio tidak pecah (-3.80 dB)")).toBeVisible();
  await expect(dialog.getByText("Sutradara ditahan security")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Salin judul" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Salin deskripsi" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Salin hashtag" })).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Ekspor sebelumnya" }).getByRole("listitem")).toHaveCount(1);
  const download = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Unduh MP4" }).click();
  expect((await download).suggestedFilename()).toMatch(/\.mp4$/);
});

test("export: cancel stays available and stops the render", async ({ page }) => {
  await openEditor(page, { scenarioStore: true, pollMs: 200, render: { ...RENDER, renderMs: 60_000 } });
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  const dialog = await startExport(page);
  await dialog.getByRole("button", { name: "Mulai ekspor" }).click();
  await expect(dialog.getByRole("list", { name: "Tahap ekspor" }).locator('[aria-current="step"]')).toHaveText(/Merender/);
  await expect(dialog.getByRole("list", { name: "Ekspor sebelumnya" })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Batalkan ekspor" }).click();
  await expect(dialog.getByText("Render dibatalkan")).toBeVisible();
  const stopped = dialog.getByRole("list", { name: "Tahap ekspor" }).locator('[aria-current="step"]');
  await expect(stopped).toHaveText(/Merender/);
  await expect(stopped).toHaveAttribute("data-step-status", "stopped");
  expect((await scenarioCalls(page)).some((call) => call[0] === "cancelRender")).toBe(true);
  await expect(dialog.getByRole("button", { name: "Coba lagi" })).toBeVisible();
});

test("export: a verification failure explains itself and 'Coba lagi' enqueues a new request", async ({ page }) => {
  await openEditor(page, { scenarioStore: true, pollMs: 150, render: { ...RENDER, renderMs: 400, outcome: "verification_failed" } });
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  const dialog = await startExport(page);
  await dialog.getByRole("button", { name: "Mulai ekspor" }).click();
  await expect(dialog.getByRole("alert")).toContainText("Hasil render tidak lolos pemeriksaan mutu");
  await dialog.getByRole("button", { name: "Coba lagi" }).click();
  await expect(dialog.getByRole("link", { name: "Unduh MP4" })).toBeVisible({ timeout: 10_000 });
  const keys = (await scenarioCalls(page)).filter((call) => call[0] === "createRender").map((call) => call[2]);
  expect(keys).toHaveLength(2);
  expect(keys[0]).not.toBe(keys[1]);
});

test("export of an unchanged clip uses the auto file (R10) and completes at once", async ({ page }) => {
  await openEditor(page, { scenarioStore: true, unchanged: true, render: { ...RENDER, instant: true } });
  const dialog = await startExport(page);
  await expect(dialog.getByText("Tanpa perubahan: file klip otomatis dipakai langsung")).toBeVisible();
  await dialog.getByRole("button", { name: "Mulai ekspor" }).click();
  await expect(dialog.getByRole("link", { name: "Unduh MP4" })).toBeVisible();
  await expect(dialog.getByRole("list", { name: "Tahap ekspor" }).locator('[data-step-status="done"]')).toHaveCount(4);
});

// ---------------------------------------------------------------------------------------------
// Layout, keyboard reach, accessibility (Appendix C.1, QG-A11Y)

for (const viewport of [{ width: 1920, height: 1080, panel: 380, timeline: 240 }, { width: 1366, height: 768, panel: 320, timeline: 200 }]) {
  test(`layout at ${viewport.width}×${viewport.height}: every region visible, nothing hidden`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openEditor(page);
    const boxes = await page.evaluate(() => Object.fromEntries(["topBar", "panels", "stage", "timeline"].map((slot) => {
      const rect = document.querySelector(`[data-slot="${slot}"]`).getBoundingClientRect();
      return [slot, { x: rect.x, y: rect.y, w: rect.width, h: rect.height }];
    })));
    expect(boxes.topBar.h).toBe(56);
    expect(boxes.panels.w).toBe(viewport.panel);
    expect(boxes.timeline.h).toBe(viewport.timeline);
    for (const box of Object.values(boxes)) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(viewport.width + 0.5);
      expect(box.y + box.h).toBeLessThanOrEqual(viewport.height + 0.5);
    }
    for (const name of ["Ekspor", "Kembali ke versi AI", "Perlu dicek (0)", "Pintasan keyboard", "Frame akhir", "Zona aman", "Putar"]) {
      await expect(page.getByRole("button", { name, exact: true })).toBeInViewport({ ratio: 1 });
    }
    const stage = await page.getByRole("img", { name: "Pratinjau klip" }).boundingBox();
    expect(Math.abs(stage.width / stage.height - 720 / 1280)).toBeLessThan(0.01);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("under 1024 px the editor explains and links back to the project", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 700 });
  await page.goto(EDITOR);
  await expect(page.getByText("Editor butuh layar minimal 1024 px")).toBeVisible();
  await expect(page.getByRole("link", { name: "Kembali ke proyek" })).toHaveAttribute("href", `/projects/${FAKE_JOB_ID}`);
});

test("every action is reachable by keyboard with a visible focus ring", async ({ page }) => {
  await openEditor(page, { scenarioStore: true });
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  await page.locator("body").click({ position: { x: 5, y: 1075 } });
  const seen = [];
  for (let i = 0; i < 60; i += 1) {
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const element = document.activeElement;
      const style = getComputedStyle(element);
      const name = element.getAttribute("aria-label") || element.textContent.trim();
      return { role: element.getAttribute("role") || element.tagName.toLowerCase(), name,
        ring: style.outlineStyle !== "none" || style.boxShadow !== "none" };
    });
    seen.push(focused);
  }
  const names = seen.map((item) => item.name);
  for (const name of ["← Proyek", "Urungkan", "Kembali ke versi AI", "Perlu dicek (0)", "Pintasan keyboard", "Ekspor",
    "Transkrip", "Putar", "Frame sebelumnya", "Frame berikutnya", "Zona aman", "Apa artinya?", "Frame akhir",
    "Posisi pemutaran", "Awal klip", "Akhir klip", "Durasi hook", "Perbesar timeline", "Perkecil timeline"]) {
    expect(names, name).toContain(name);
  }
  expect(seen.filter((entry) => entry.role !== "body" && !entry.ring).map((entry) => `${entry.role}: ${entry.name}`), "focused without a ring").toEqual([]);
});

async function axeViolations(page) {
  await page.addScriptTag({ content: AXE });
  return page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ["violations"] });
    return result.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.length,
      targets: violation.nodes.slice(0, 3).map((node) => node.target.join(" ")) }));
  });
}

test("QG-A11Y: axe finds no critical or serious violation in any editor state", async ({ page, browser }) => {
  test.skip(!AXE, "axe-core is not a web dependency yet: set AXE_CORE_PATH to an axe.min.js (see the T2.6 request)");
  test.setTimeout(180_000);
  const results = [];
  const record = async (label) => {
    const violations = await axeViolations(page);
    results.push({ state: label, viewport: page.viewportSize(), violations,
      critical: violations.filter((item) => item.impact === "critical").length,
      serious: violations.filter((item) => item.impact === "serious").length });
  };
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }]) {
    await page.setViewportSize(viewport);
    await openEditor(page, { scenarioStore: true, pollMs: 200, render: RENDER, rev0Exact: true, autoRenderUrl: AUTO_RENDER,
      planWarnings: [{ code: "tight_cut", ref: "rm_01", f: 120 }] });
    await record("editor (revision 0, auto render)");
    await page.getByRole("button", { name: "Apa artinya?" }).click();
    await record("badge help open");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Perlu dicek (1)" }).click();
    await record("checks panel open");
    await page.keyboard.press("Escape");
    await page.keyboard.press("?");
    await record("shortcut help open");
    await page.keyboard.press("Escape");
    await page.keyboard.press("'");
    await record("safe zone on");
    await page.keyboard.press("'");
    await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
    const dialog = await startExport(page);
    await record("export dialog");
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Mulai ekspor" }).click();
    await expect(dialog.getByRole("link", { name: "Unduh MP4" })).toBeVisible({ timeout: 15_000 });
    await record("export completed");
  }
  await openEditor(page, { scenarioStore: true, conflict: { parts: [{ id: "hook", label: "Teks hook" }] } });
  await record("conflict dialog");
  await openEditor(page, { scenarioStore: true, readOnly: "transcript_changed", docPatch: { "base.engine.compiler": "legacy" } });
  await record("read-only + legacy notice");
  const version = await axeVersion(page);
  writeGate("QG-A11Y.json", { gate: "QG-A11Y", axe: version, browser: browser.version(), executable: chrome ?? "playwright-default",
    states: results.length, critical: results.reduce((sum, item) => sum + item.critical, 0),
    serious: results.reduce((sum, item) => sum + item.serious, 0), results });
  for (const item of results) {
    expect(item.violations.filter((violation) => ["critical", "serious"].includes(violation.impact)), item.state).toEqual([]);
  }
});

async function axeVersion(page) {
  return page.evaluate(() => window.axe?.version ?? null);
}

// ---------------------------------------------------------------------------------------------
// Gates with time limits (PF-OPEN; scripted QG-UX U1 and U6)

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

test("PF-OPEN: interactive ≤ 3.0 s p95 on a first visit and ≤ 2.0 s p95 on a repeat visit", async ({ browser, workerStorageState }) => {
  test.skip(!runGates, "EDITOR_GATES=1 runs the timing gates");
  test.setTimeout(600_000);
  const runs = Number(process.env.EDITOR_GATES_RUNS || 20);
  // Simulated server time per open, from the W1 numbers: CLI round trip 90 ms per call [R1] and
  // the PF-PLAN server budget (200 ms p95) for the plan.
  const variants = [
    { name: "fakes, no server latency", config: { rev0Exact: true, autoRenderUrl: AUTO_RENDER } },
    { name: "fakes + simulated server latency", config: { rev0Exact: true, autoRenderUrl: AUTO_RENDER,
      latency: { api: { getEdit: 90, words: 90, clips: 90 }, preview: { plan: 200 } } } },
  ];
  const report = { gate: "PF-OPEN", browser: browser.version(), executable: chrome ?? "playwright-default", runs, variants: [] };
  for (const variant of variants) {
    const first = [];
    const repeat = [];
    for (let run = 0; run < runs; run += 1) {
      const context = await browser.newContext({ baseURL: settings.baseURL, storageState: workerStorageState, viewport: { width: 1366, height: 768 } });
      const page = await context.newPage();
      await page.addInitScript(installScenario, variant.config);
      await page.route(`**${AUTO_RENDER}`, (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: tinyMp4 }));
      await page.goto(EDITOR);
      await page.waitForFunction(() => window.__openMs !== undefined, null, { timeout: 30_000 });
      first.push(await page.evaluate(() => window.__openMs));
      await page.goto(EDITOR);
      await page.waitForFunction(() => window.__openMs !== undefined, null, { timeout: 30_000 });
      repeat.push(await page.evaluate(() => window.__openMs));
      await context.close();
    }
    report.variants.push({ name: variant.name, config: variant.config.latency ?? null,
      first_visit_ms: { p50: percentile(first, 50), p95: percentile(first, 95), max: Math.max(...first) },
      repeat_visit_ms: { p50: percentile(repeat, 50), p95: percentile(repeat, 95), max: Math.max(...repeat) } });
  }
  report.pass = report.variants.every((variant) => variant.first_visit_ms.p95 <= 3000 && variant.repeat_visit_ms.p95 <= 2000);
  writeGate("PF-OPEN.json", report);
  for (const variant of report.variants) {
    expect(variant.first_visit_ms.p95, variant.name).toBeLessThanOrEqual(3000);
    expect(variant.repeat_visit_ms.p95, variant.name).toBeLessThanOrEqual(2000);
  }
});

test("QG-UX U1 (scripted): fix a clipped first word in ≤ 20 s", async ({ page, browser }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  await openEditor(page, { scenarioStore: true, docPatch: { "main.segments.0.in_sf": 37225 },
    latency: { api: { putEdit: 90 }, preview: { plan: 200 } } });
  const t0 = await page.evaluate(() => performance.now());
  const px = await pxPerFrame(page);
  await dragBy(page, page.getByRole("slider", { name: "Awal klip" }), -3 * px);
  await expect.poll(async () => (await editorState(page)).doc.main.segments[0].in_sf).toBe(37220);
  await expect.poll(async () => {
    const state = await editorState(page);
    return [state.revision, state.save]; // the saved revision (the store's `doc` keeps the loaded one)
  }, { timeout: 10_000 }).toEqual([1, "saved"]);
  await expect(page.getByTestId("save-status")).toHaveText(/^Tersimpan/);
  await expect(badge(page)).toHaveText("● Sesuai hasil akhir");
  const elapsed = (await page.evaluate(() => performance.now())) - t0;
  writeGate("QG-UX-U1.json", { gate: "QG-UX U1 (scripted)", limit_ms: 20_000, elapsed_ms: Math.round(elapsed),
    viewport: page.viewportSize(), browser: browser.version(), steps: ["drag Awal klip left to the word gap", "autosave (1.5 s debounce)"],
    pass: elapsed <= 20_000 });
  expect(elapsed).toBeLessThanOrEqual(20_000);
});

test("QG-UX U6 (scripted): export and download in ≤ clip length + 30 s", async ({ page, browser }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1366, height: 768 });
  const clipMs = 10_010;
  // Render time simulated at the W1 PF-RENDER p95 (0.347× clip length) with the default 1 s poll.
  const render = { queueMs: 500, renderMs: Math.round(0.347 * clipMs), verifyMs: 400, resultUrl: EXPORT_MP4, srtUrl: EXPORT_SRT };
  await openEditor(page, { scenarioStore: true, render, planWarnings: [{ code: "tight_cut", ref: "rm_01", f: 120 }] });
  await page.evaluate(() => window.__potonginEditor.store.dispatch("SetCaptionsEnabled", { on: false }));
  const t0 = await page.evaluate(() => performance.now());
  const dialog = await startExport(page);
  await dialog.getByRole("checkbox").check();
  await dialog.getByRole("button", { name: "Mulai ekspor" }).click();
  const link = dialog.getByRole("link", { name: "Unduh MP4" });
  await expect(link).toBeVisible({ timeout: 60_000 });
  const download = page.waitForEvent("download");
  await link.click();
  await download;
  const elapsed = (await page.evaluate(() => performance.now())) - t0;
  writeGate("QG-UX-U6.json", { gate: "QG-UX U6 (scripted)", clip_ms: clipMs, limit_ms: clipMs + 30_000, elapsed_ms: Math.round(elapsed),
    simulated_render_ms: render.queueMs + render.renderMs + render.verifyMs, poll_ms: 1000, viewport: page.viewportSize(),
    browser: browser.version(), pass: elapsed <= clipMs + 30_000 });
  expect(elapsed).toBeLessThanOrEqual(clipMs + 30_000);
});

// ---------------------------------------------------------------------------------------------
// Project page entry (behind POTONGIN_EDITOR_V3: the listing route answers only when it is on)

const PROJECT_JOB = "2d3c4b5a-6978-4a1b-8c2d-3e4f5a6b7c8d";
const CLIP_A = "clip_" + "a".repeat(24);
const CLIP_B = "clip_" + "b".repeat(24);

// `context`: a job made with Konteks Tren and Fokus klip (main's features beside the editor).
const CONTEXT_TREND = { id: "0b6f2c1e-8d7a-4c3b-9f21-6a5e4d3c2b1a", title: "Kabur Aja Dulu", kind: "topic" };
const CONTEXT_CLIPS = {
  1: { trends: [CONTEXT_TREND], focus: { match: "literal", terms: ["jomok"], at: 754 } },
  2: { focus: { match: "semantic", terms: ["jomok"], at: null } },
  3: { focus: { match: "none", terms: [], at: null } },
  4: { trends: [CONTEXT_TREND], focus: { match: "none", terms: [], at: null } },
};

function projectJob({ context = false } = {}) {
  const clip = (index, title) => ({
    index, title, hookText: `Hook ${index}`, description: `Deskripsi ${index}`, hashtags: ["#uji"], text: `Teks ${index}`,
    duration: 42, start: 10, end: 52, score: 8.1, selectionSource: "llm", archetype: "humor", reasons: [],
    videoUrl: `/api/jobs/${PROJECT_JOB}/files/output/clip-0${index}.mp4`, downloadUrl: `/api/jobs/${PROJECT_JOB}/files/output/clip-0${index}.mp4?download=1`,
    subtitleUrl: null, metadataVersion: 5, ...(context ? CONTEXT_CLIPS[index] : {}),
  });
  const selectionV3 = context ? {
    mode: "v3", status: "completed", source: "llm", provider: "groq", model: "m", prompt_version: "llm-select-v2+trends.v1+focus.v1",
    warnings: ["focus_few_matches:2"], artifact: "analysis/selection.v3.json", transcript_source: "whisper",
    focus: { terms: ["jomok"], matched: 2, requested: 4 },
  } : null;
  return {
    id: PROJECT_JOB, status: "completed", progress: 100, stage: "completed", stageDetail: "Selesai", createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-24T10:30:00.000Z", source: { type: "upload", name: "Podcast uji" }, error: null,
    options: { selectionMode: "v3", renderMode: "fit-blur", ...(context ? { focus: { terms: ["jomok"], mode: "prefer" } } : {}) }, selectionV3,
    clips: [clip(1, "Klip satu"), clip(2, "Klip dua"), clip(3, "Klip tiga"), clip(4, "Klip empat")],
  };
}

function listingClip(index, fields) {
  return { clipId: null, index, title: `Klip ${index}`, hookText: null, description: null, hashtags: [], durationMs: 42_000,
    engine: "edit-v2/1", edit: null, latestRender: null, openable: false, reason: null, ...fields };
}

async function mockProject(page, { clipsStatus = 200, context = false } = {}) {
  let preparedNow = false;
  const posts = [];
  await page.route(`**/api/jobs/${PROJECT_JOB}`, (route) => route.fulfill({ json: { job: projectJob({ context }) } }));
  await page.route(`**/api/jobs/${PROJECT_JOB}/files/**`, (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: tinyMp4 }));
  await page.route(`**/api/jobs/${PROJECT_JOB}/clips`, async (route) => {
    if (route.request().method() === "POST") {
      posts.push(route.request().postData());
      await new Promise((resolve) => setTimeout(resolve, 1200)); // words, waveform and camera plans take a while
      preparedNow = true;
      return route.fulfill({ status: 202, json: { state: "done", clips: [] } });
    }
    if (clipsStatus !== 200) return route.fulfill({ status: clipsStatus, json: { code: "editor_disabled" } });
    return route.fulfill({ json: { clips: [
      listingClip(1, { clipId: CLIP_A, openable: true, edit: { state: "edited", revision: 3, etag: "c".repeat(64), updatedAtMs: 1 },
        latestRender: { renderId: "r-1", state: "completed", revision: 3, url: `/api/jobs/${PROJECT_JOB}/files/output/edits/${CLIP_A}/0123456789abcdef.mp4`,
          srtUrl: `/api/jobs/${PROJECT_JOB}/files/output/edits/${CLIP_A}/0123456789abcdef.srt` } }),
      listingClip(2, { clipId: CLIP_B, openable: true, edit: { state: "seed", revision: 0, etag: "d".repeat(64), updatedAtMs: 1 }, engine: "legacy" }),
      listingClip(3, { clipId: "clip_" + "c".repeat(24), openable: false, reason: "source_missing", edit: { state: "seed", revision: 0, etag: "e".repeat(64), updatedAtMs: 1 } }),
      preparedNow
        ? listingClip(4, { clipId: FAKE_CLIP_ID, openable: true, edit: { state: "seed", revision: 0, etag: "f".repeat(64), updatedAtMs: 1 } })
        : listingClip(4, { reason: "needs_prepare" }),
    ] } });
  });
  return posts;
}

const projectCard = (page, index) => page.getByRole("article").nth(index - 1);

test("project page: 'Edit klip' on every clip that can be edited, its badge and its latest export", async ({ page }) => {
  const posts = await mockProject(page);
  await page.goto(`/projects/${PROJECT_JOB}`);
  const card = (index) => projectCard(page, index);
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(card(1).getByRole("link", { name: "Edit klip" })).toHaveAttribute("href", `/projects/${PROJECT_JOB}/clips/${CLIP_A}/edit`);
  await expect(card(1).getByText("Diedit · revisi 3")).toBeVisible();
  await expect(card(1).getByRole("link", { name: "Ekspor terakhir · revisi 3" })).toHaveAttribute("href",
    `/api/jobs/${PROJECT_JOB}/files/output/edits/${CLIP_A}/0123456789abcdef.mp4`);
  await expect(card(2).getByRole("link", { name: "Edit klip" })).toHaveAttribute("href", `/projects/${PROJECT_JOB}/clips/${CLIP_B}/edit`);
  await expect(card(3).getByRole("link", { name: "Edit klip" })).toHaveCount(0);
  await expect(card(3).getByText("Video sumber sudah tidak ada")).toBeVisible();
  // A clip of a job that was never prepared links to the editor too, by its number: no step by hand.
  await expect(card(4).getByRole("link", { name: "Edit klip" })).toHaveAttribute("href", `/projects/${PROJECT_JOB}/clips/klip-4/edit`);
  await expect(page.getByRole("button", { name: /Siapkan/ })).toHaveCount(0);
  await expect(page.getByText(/perlu disiapkan|mesin (?:lama|baru)/i)).toHaveCount(0);
  // "Edit klip" is each card's first action.
  const first = await card(2).getByRole("link", { name: "Edit klip" }).evaluate((link) => link.parentElement.firstElementChild === link);
  expect(first).toBe(true);
  expect(posts).toEqual([]);
});

test("opening a clip that was never prepared prepares it in the editor, with progress, then opens it", async ({ page }) => {
  const posts = await mockProject(page);
  await page.goto(`/projects/${PROJECT_JOB}`);
  await projectCard(page, 4).getByRole("link", { name: "Edit klip" }).click();
  await expect(page.getByRole("heading", { name: "Menyiapkan klip untuk diedit" })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Menyiapkan transkrip kata, waveform, dan wajah." })).toBeVisible();
  await expect(page.locator("[data-prepare-seconds]")).toHaveText(/^\d+ dtk$/);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  // The address becomes the clip's own, so a reload opens it directly.
  expect(new URL(page.url()).pathname).toBe(`/projects/${PROJECT_JOB}/clips/${FAKE_CLIP_ID}/edit`);
  expect(posts).toEqual(["{}"]);
});

test("a clip that cannot be edited says why in the editor and links back", async ({ page }) => {
  await mockProject(page);
  await page.goto(`/projects/${PROJECT_JOB}/clips/klip-3/edit`);
  await expect(page.getByRole("heading", { name: "Klip tidak bisa dibuka" })).toBeVisible();
  await expect(page.getByText("Video sumber sudah tidak ada")).toBeVisible();
  await expect(page.getByRole("link", { name: "Kembali ke proyek" })).toHaveAttribute("href", `/projects/${PROJECT_JOB}`);
});

test("project page: trend and focus chips and the editor entry share each card", async ({ page }) => {
  await mockProject(page, { context: true });
  await page.goto(`/projects/${PROJECT_JOB}`);
  const card = (index) => projectCard(page, index);
  const trendChips = (index) => card(index).getByRole("list", { name: "Tren yang disebut di klip ini" }).getByRole("listitem");
  await expect(page.locator("p").filter({ hasText: /^Fokus:/ })).toHaveText("Fokus: jomok · 2 dari 4 klip cocok");
  await expect(card(1).locator("[data-focus]")).toHaveText("Menyebut 'jomok' · 12:34");
  await expect(trendChips(1)).toHaveText(["Nyambung tren: Kabur Aja Dulu"]);
  await expect(card(1).getByRole("link", { name: "Edit klip" })).toHaveAttribute("href", `/projects/${PROJECT_JOB}/clips/${CLIP_A}/edit`);
  await expect(card(1).getByText("Diedit · revisi 3")).toBeVisible();
  await expect(card(2).locator("[data-focus]")).toHaveText("Terkait 'jomok' (menurut AI)");
  await expect(card(2).getByRole("link", { name: "Edit klip" })).toHaveAttribute("href", `/projects/${PROJECT_JOB}/clips/${CLIP_B}/edit`);
  await expect(card(3).locator("[data-focus]")).toHaveText("Di luar fokus");
  await expect(card(3).getByText("Video sumber sudah tidak ada")).toBeVisible();
  await expect(trendChips(4)).toHaveText(["Nyambung tren: Kabur Aja Dulu"]);
  await expect(card(4).getByRole("link", { name: "Edit klip" })).toBeVisible();
  // In each card: the focus chip above the title, then the trend chips, then "Edit klip".
  const order = await card(1).evaluate((article) => {
    const at = (element) => [...article.querySelectorAll("*")].indexOf(element);
    return {
      focus: at(article.querySelector("[data-focus]")),
      title: at(article.querySelector("h3")),
      trends: at(article.querySelector('[aria-label="Tren yang disebut di klip ini"]')),
      edit: at([...article.querySelectorAll("a")].find((link) => link.textContent === "Edit klip")),
    };
  });
  expect(order.focus).toBeGreaterThan(-1);
  expect(order.title).toBeGreaterThan(order.focus);
  expect(order.trends).toBeGreaterThan(order.title);
  expect(order.edit).toBeGreaterThan(order.trends);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card(1).getByRole("link", { name: "Edit klip" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});

test("project page: without the editor flag the chips stay and no editor entry shows", async ({ page }) => {
  page.allowConsole.push(/404/);
  await mockProject(page, { clipsStatus: 404, context: true });
  await page.goto(`/projects/${PROJECT_JOB}`);
  await expect(page.getByRole("article")).toHaveCount(4);
  await expect(projectCard(page, 1).locator("[data-focus]")).toHaveText("Menyebut 'jomok' · 12:34");
  await expect(page.getByRole("list", { name: "Tren yang disebut di klip ini" })).toHaveCount(2);
  await expect(page.getByRole("link", { name: "Edit klip" })).toHaveCount(0);
  await expect(page.getByText("Diedit · revisi 3")).toHaveCount(0);
});

test("history: 'Edit klip' on a finished project opens its clip list, only while the editor is on", async ({ page }) => {
  let editor = true;
  const finished = { ...projectJob(), id: PROJECT_JOB };
  const running = { ...projectJob(), id: "3e4d5c6b-7a89-4b2c-9d3e-4f5a6b7c8d9e", status: "processing", progress: 40, clips: [] };
  await page.route("**/api/jobs", (route) => route.fulfill({ json: { jobs: [finished, running], total: 2, editor } }));
  await page.route(`**/api/jobs/${PROJECT_JOB}/files/**`, (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: tinyMp4 }));
  await page.goto("/projects");
  const rows = page.getByRole("list", { name: "Proyek" }).getByRole("listitem");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole("link", { name: "Edit klip Podcast uji" })).toHaveAttribute("href", `/projects/${PROJECT_JOB}#klip`);
  await expect(rows.nth(1).getByRole("link", { name: /^Edit klip/ })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(rows.nth(0).getByRole("link", { name: "Edit klip Podcast uji" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  editor = false;
  await page.getByRole("button", { name: "Muat ulang" }).click();
  await expect(page.getByRole("link", { name: /^Edit klip/ })).toHaveCount(0);
});
