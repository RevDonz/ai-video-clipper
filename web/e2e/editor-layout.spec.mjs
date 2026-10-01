// Editor V3 layout panel, "Tata letak" (plan §11.3 T3.6, §5.7, §3.3 `layout.default.mode`,
// Appendix B `SetLayout`, Appendix C.6). Runs against the T1.Z fakes (plan §11.0 "TDD protocol"):
// switching between the three layouts, face-track analysed before the switch (with its progress,
// a failure and a change of mind), the truth-frame thumbnails at the playhead, the runs without a
// face with jump-to, undo, read-only and axe.
//
// Prerequisites (as web/e2e/editor-shell.spec.mjs): a server with POTONGIN_EDITOR_V3=on and
// POTONGIN_EDITOR_FAKES=1, E2E_EDITOR_FAKES=1 to run this file, E2E_USERNAME/E2E_PASSWORD; optional
// AXE_CORE_PATH=<axe.min.js>. The browser is Chrome for Testing 147.0.7727.15 (Playwright build 1217)
// when installed; EDITOR_CHROME overrides it.
import { expect, test as base } from "@playwright/test";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID } from "../components/editor/__dev__/fakes.mjs";
import { login, settings } from "./support/harness.mjs";

const EDITOR = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit`;

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

// ---------------------------------------------------------------------------------------------
// Browser-side scenario (serialised by addInitScript; self-contained). The fake runtime passes the
// API, the preview client and the store through window.__potonginEditorScenario hooks; the panel
// asks the fake runtime's preview client for its thumbnails (window.__potonginEditor.previewClient).
function installScenario(config) {
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const calls = [];
  const thumbs = [];
  window.__scenarioCalls = calls;
  window.__thumbCalls = thumbs;
  let cameraReady = Boolean(config.cameraSeed);
  let failures = config.prepareFails ?? 0;
  const COLORS = { fit_blur: "#2f6fed", camera: "#1c9d5b", fill_center: "#d9822b" };

  async function png(layout, frame) {
    const canvas = new OffscreenCanvas(90, 160);
    const context = canvas.getContext("2d");
    context.fillStyle = COLORS[layout] ?? "#888";
    context.fillRect(0, 0, 90, 160);
    context.fillStyle = "#fff";
    context.fillRect(0, 150, Math.min(90, 1 + frame), 10);
    return canvas.convertToBlob({ type: "image/png" });
  }

  function scenarioStore(fakes, parts) {
    const listeners = new Set();
    const past = [];
    const future = [];
    let planSeq = 0;
    let state = { status: "loading", doc: null, seed: null, words: null, etag: null, revision: null, save: "saved", savedAtMs: null,
      canUndo: false, canRedo: false, plan: null, pending: [], warnings: [], selection: null, commands: [], conflict: null,
      readOnlyReason: null, previewError: null, jobId: fakes.FAKE_JOB_ID, clipId: fakes.FAKE_CLIP_ID };
    const set = (patch) => {
      state = { ...state, ...patch, canUndo: past.length > 0, canRedo: future.length > 0 };
      for (const listener of [...listeners]) listener(state);
    };
    const replan = async (doc) => {
      const seq = ++planSeq;
      set({ pending: ["text"] });
      try {
        const plan = await parts.previewClient.plan(doc);
        if (seq === planSeq) set({ plan, pending: [], warnings: plan.warnings, previewError: null });
      } catch (error) {
        if (seq !== planSeq) return;
        set({ pending: [], previewError: { code: error?.code ?? "preview_failed" } });
        setTimeout(() => { if (seq === planSeq) replan(state.doc); }, 400); // the real store polls again
      }
    };
    const change = (doc, extra = {}) => {
      set({ doc, save: "dirty", ...extra });
      replan(doc);
    };
    const store = {
      getState: () => state,
      dispatch(type, args = {}, options = {}) {
        if (!fakes.COMMANDS.includes(type)) throw new fakes.CommandRejected("unknown_command");
        if (state.status !== "ready") throw new fakes.CommandRejected("read_only");
        const next = clone(state.doc);
        if (type === "SetLayout") {
          if (!["fit_blur", "camera", "fill_center"].includes(args.mode)) throw new fakes.CommandRejected("value_out_of_range");
          next.layout.default.mode = args.mode;
        }
        next.audit.last_command = type;
        calls.push(["dispatch", type, clone(args)]);
        past.push(state.doc);
        future.length = 0;
        change(next, { commands: [...state.commands, { type, args, mergeKey: options.mergeKey ?? null }] });
        return next;
      },
      undo() {
        if (!past.length) return;
        future.push(state.doc);
        change(past.pop());
      },
      redo() {
        if (!future.length) return;
        past.push(state.doc);
        change(future.pop());
      },
      async flush() { set({ save: "saved", savedAtMs: Date.now() }); },
      resolveConflict() { set({ conflict: null }); },
      startFromSeed() { set({ status: "ready", readOnlyReason: null }); },
      setSelection(selection) { set({ selection }); },
      dismissNotice() {},
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      destroy() { listeners.clear(); },
    };
    (async () => {
      const edit = await parts.api.getEdit({ seed: false });
      const words = await parts.api.words(edit.words.url);
      set({ status: edit.readOnly ? "readOnly" : "ready", readOnlyReason: edit.readOnlyReason ?? null, doc: edit.doc,
        seed: clone(edit.doc), words, etag: edit.etag, revision: edit.doc.revision, savedAtMs: Date.now() });
      await replan(edit.doc);
    })();
    return store;
  }

  window.__potonginEditorScenario = {
    api(api, fakes) {
      let out = api;
      // a face-track seed: its layout is face-track and it names its camera plan (plan §3.5)
      const patch = { ...(config.cameraSeed ? { "layout.default.mode": "camera", "base.camera.sha256": "c".repeat(64) } : {}),
        ...(config.docPatch ?? {}) };
      if (Object.keys(patch).length) {
        const doc = fakes.fakeDoc();
        for (const [pathText, value] of Object.entries(patch)) {
          const keys = pathText.split(".");
          let target = doc;
          for (const key of keys.slice(0, -1)) target = target[key];
          target[keys.at(-1)] = value;
        }
        out = fakes.createFakeApiClient({ doc });
      }
      const inner = out;
      let progress = null;
      out = {
        ...inner,
        async prepare(options = {}) {
          calls.push(["prepare", clone(options)]);
          if (options.layout === "camera" && !cameraReady) {
            const total = 240;
            const started = Date.now();
            progress = () => ({ state: "building", done: Math.min(total, Math.floor(((Date.now() - started) / (config.prepareMs ?? 1)) * total)), total });
            await wait(config.prepareMs ?? 0);
            progress = null;
            if (failures > 0) {
              failures -= 1;
              throw new fakes.FakeApiError(503, "backend_unavailable");
            }
            cameraReady = true;
          }
          return inner.prepare(options);
        },
      };
      if (config.progress) {
        out.cameraProgress = async () => {
          calls.push(["cameraProgress"]);
          return progress ? progress() : { state: cameraReady ? "ready" : "none" };
        };
      }
      if (config.readOnly) {
        const getEdit = out.getEdit;
        out = { ...out, getEdit: async (options) => ({ ...(await getEdit(options)), readOnly: true, readOnlyReason: config.readOnly }) };
      }
      return out;
    },
    previewClient(client, fakes) {
      const wrapped = {
        ...client,
        async plan(doc) {
          if (doc.layout.default.mode === "camera" && !cameraReady) throw new fakes.FakeApiError(409, "analysis_missing");
          const dto = await client.plan(doc);
          dto.warnings = doc.layout.default.mode === "camera"
            ? (config.noFace ?? []).map((f) => ({ code: "no_face", path: "/layout/default/mode", f }))
            : [];
          return dto;
        },
        async frame(doc, f) {
          const layout = doc.layout.default.mode;
          thumbs.push({ layout, f });
          if (config.frameMs) await wait(config.frameMs);
          if (layout === "camera" && !cameraReady) throw new fakes.FakeApiError(409, "analysis_missing");
          return png(layout, f);
        },
      };
      window.__scenarioPreview = wrapped;
      return wrapped;
    },
    store(store, fakes, parts) {
      store.ready?.catch?.(() => {}); // the replaced fake store may still plan once; its answer is unused
      store.destroy();
      return scenarioStore(fakes, parts);
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
    // the fake runtime makes no API call: any request the panel sends to the editor routes is a bug
    page.on("request", (request) => {
      if (/\/api\/jobs\/[^/]+\/clips\//.test(request.url())) failures.requests.push(`unexpected ${request.method()} ${request.url()}`);
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
  viewport: { width: 1920, height: 1080 },
  deviceScaleFactor: 1,
});
test.skip(process.env.E2E_EDITOR_FAKES !== "1",
  "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

async function openLayoutPanel(page, config = {}, { planned = true } = {}) {
  await page.addInitScript(installScenario, config);
  await page.goto(EDITOR);
  if (planned) {
    await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  } else {
    // no plan yet (the server cannot plan the document): the editor is open, the stage waits
    await expect(page.locator('[data-editor-status="ready"]')).toBeVisible({ timeout: 30_000 });
  }
  // the fake runtime exposes its store, player and API; the panel also finds its preview client there
  await page.evaluate(() => { window.__potonginEditor.previewClient = window.__scenarioPreview; });
  await page.getByRole("tab", { name: "Tata letak" }).click();
  const panel = page.locator('[data-panel="layout"]');
  await expect(panel).toBeVisible();
  return panel;
}

const layoutOf = (page) => page.evaluate(() => window.__potonginEditor.store.getState().doc.layout.default.mode);
const calls = (page) => page.evaluate(() => window.__scenarioCalls);
const thumbCalls = (page) => page.evaluate(() => window.__thumbCalls);
const radio = (panel, name) => panel.getByRole("radio", { name: new RegExp(`^${name}`) });

test("Tata letak lists the three layouts, the clip's own chosen, with thumbnails at the playhead", async ({ page }) => {
  const panel = await openLayoutPanel(page);
  await expect(panel.getByRole("radio")).toHaveCount(3);
  await expect(radio(panel, "Latar blur")).toBeChecked();
  await expect(radio(panel, "Ikuti wajah")).not.toBeChecked();
  await expect(radio(panel, "Potong tengah")).not.toBeChecked();
  await expect(panel.getByText("Berlaku untuk seluruh klip.")).toBeVisible();
  // truth frames of the document in each layout, the current one first
  await expect(panel.locator('img[data-layout-thumb="fit_blur"]')).toHaveJSProperty("complete", true);
  await expect(panel.locator('img[data-layout-thumb="fill_center"]')).toBeVisible();
  await expect.poll(async () => panel.locator('img[data-layout-thumb="fit_blur"]').evaluate((img) => img.naturalWidth)).toBe(90);
  await expect(panel.locator('img[data-layout-thumb="fit_blur"]')).toHaveAttribute("alt", "Contoh Latar blur di 00:00,0");
  // face-track has no camera plan yet: the thumbnail says so instead of guessing
  await expect(panel.locator('[data-layout-option="camera"]')).toContainText("Perlu analisis wajah");
  await expect(panel.locator('img[data-layout-thumb="camera"]')).toHaveCount(0);
  const first = (await thumbCalls(page)).slice(0, 3);
  expect(first).toEqual([{ layout: "fit_blur", f: 0 }, { layout: "camera", f: 0 }, { layout: "fill_center", f: 0 }]);
});

test("the chosen layout is explained under the choices", async ({ page }) => {
  const panel = await openLayoutPanel(page);
  const about = panel.locator("[data-layout-about]");
  await expect(about).toHaveText(/^Latar blur: Seluruh gambar terlihat\./);
  await radio(panel, "Potong tengah").check();
  await expect(about).toHaveText(/^Potong tengah: Potongan 9:16 tetap di tengah gambar\./);
  // every choice keeps its own description for screen readers
  await expect(radio(panel, "Ikuti wajah")).toHaveAccessibleDescription(/Butuh analisis wajah sekali per klip/);
  await expect(panel.getByRole("group", { name: "Pilih tata letak" })).toBeVisible();
});

test("at 1366×768 the face analysis stays in view on its card", async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  const panel = await openLayoutPanel(page, { prepareMs: 2500 });
  await radio(panel, "Ikuti wajah").check();
  await expect(panel.locator('[data-layout-card-progress="camera"]')).toBeInViewport();
  await expect.poll(() => layoutOf(page), { timeout: 15_000 }).toBe("camera");
  const overflow = await page.locator('[data-panel="layout"]').evaluate((node) => node.scrollWidth - node.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("with reduced motion the panel does not animate", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const panel = await openLayoutPanel(page);
  const card = panel.locator('[data-layout-option="fill_center"]');
  const duration = await card.evaluate((node) => getComputedStyle(node).transitionDuration);
  // The app's global reduced-motion rule (app/globals.css) cuts every transition to 0.01 ms, i.e.
  // a jump with no visible animation; anything from 1 ms up would move.
  const ms = (value) => Number.parseFloat(value) * (value.trim().endsWith("ms") ? 1 : 1000);
  expect(duration.split(",").every((value) => ms(value) < 1)).toBe(true);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  const moving = await card.evaluate((node) => getComputedStyle(node).transitionDuration);
  expect(moving.split(",").some((value) => Number.parseFloat(value) > 0)).toBe(true);
});

test("the thumbnails follow the playhead", async ({ page }) => {
  const panel = await openLayoutPanel(page);
  await expect(panel.locator('img[data-layout-thumb="fit_blur"]')).toBeVisible();
  await page.getByRole("button", { name: "Frame berikutnya" }).click();
  await page.getByRole("button", { name: "Frame berikutnya" }).click();
  await expect.poll(async () => (await thumbCalls(page)).filter((entry) => entry.f === 2).map((entry) => entry.layout))
    .toEqual(["fit_blur", "camera", "fill_center"]);
  await expect(panel.locator('img[data-layout-thumb="fit_blur"]')).toHaveAttribute("alt", "Contoh Latar blur di 00:00,0");
});

test("choosing Potong tengah switches the whole clip at once; undo and redo follow", async ({ page }) => {
  const panel = await openLayoutPanel(page);
  await radio(panel, "Potong tengah").check();
  await expect.poll(() => layoutOf(page)).toBe("fill_center");
  await expect(radio(panel, "Potong tengah")).toBeChecked();
  expect((await calls(page)).filter((entry) => entry[0] === "dispatch")).toEqual([["dispatch", "SetLayout", { mode: "fill_center" }]]);
  expect((await calls(page)).filter((entry) => entry[0] === "prepare")).toEqual([]);
  // (a focused radio keeps the keyboard, so the top bar's buttons undo and redo here)
  await page.getByRole("button", { name: "Urungkan" }).click();
  await expect.poll(() => layoutOf(page)).toBe("fit_blur");
  await expect(radio(panel, "Latar blur")).toBeChecked();
  await page.getByRole("button", { name: "Ulangi" }).click();
  await expect.poll(() => layoutOf(page)).toBe("fill_center");
  await expect(radio(panel, "Potong tengah")).toBeChecked();
  await radio(panel, "Latar blur").check();
  await expect.poll(() => layoutOf(page)).toBe("fit_blur");
});

test("Ikuti wajah analyses the faces first, with the server's progress, then switches", async ({ page }) => {
  const panel = await openLayoutPanel(page, { prepareMs: 2500, progress: true });
  await radio(panel, "Ikuti wajah").check();
  const analysis = panel.locator("[data-layout-analysis]");
  await expect(analysis.locator("[data-layout-analysis-text]")).toHaveText(/^Menganalisis wajah… \d+%$/);
  await expect(analysis).not.toContainText("/240"); // samples mean nothing to the user
  const bar = analysis.getByRole("progressbar", { name: "Analisis wajah" });
  await expect(bar).toHaveAttribute("max", "240");
  // the chosen card carries the progress too, where the eye is
  const cardProgress = panel.locator('[data-layout-card-progress="camera"]');
  await expect(cardProgress).toBeVisible();
  await expect(cardProgress).toContainText(/\d+%/);
  // nothing switches while the faces are analysed: the stage keeps the current layout
  expect(await layoutOf(page)).toBe("fit_blur");
  await expect(radio(panel, "Ikuti wajah")).toBeChecked(); // the choice being prepared
  await expect(panel.locator('[data-layout-option="fit_blur"]')).toContainText("Dipakai");
  await expect.poll(() => layoutOf(page), { timeout: 15_000 }).toBe("camera");
  await expect(analysis).toBeHidden();
  await expect(cardProgress).toHaveCount(0);
  await expect(panel.getByText("Dipakai", { exact: true })).toHaveCount(0); // nothing pending: the check mark says it
  const log = await calls(page);
  const prepare = log.findIndex((entry) => entry[0] === "prepare");
  const dispatch = log.findIndex((entry) => entry[0] === "dispatch");
  expect(log[prepare]).toEqual(["prepare", { layout: "camera" }]);
  expect(dispatch).toBeGreaterThan(prepare);
  expect(log[dispatch]).toEqual(["dispatch", "SetLayout", { mode: "camera" }]);
  expect(log.some((entry) => entry[0] === "cameraProgress")).toBe(true);
  // its thumbnail now shows the face-track frame
  await expect(panel.locator('img[data-layout-thumb="camera"]')).toBeVisible();
  // switching back and forth needs no second analysis
  await radio(panel, "Latar blur").check();
  await expect.poll(() => layoutOf(page)).toBe("fit_blur");
  await radio(panel, "Ikuti wajah").check();
  await expect.poll(() => layoutOf(page)).toBe("camera");
  await expect(analysis).toBeHidden();
});

test("without the server's progress the analysis shows the seconds and the usual length", async ({ page }) => {
  const panel = await openLayoutPanel(page, { prepareMs: 2600 });
  await radio(panel, "Ikuti wajah").check();
  const analysis = panel.locator("[data-layout-analysis]");
  await expect(analysis).toContainText(/Menganalisis wajah… \d+ dtk \(biasanya \d+-\d+ dtk\)/);
  await expect(panel.locator('[data-layout-card-progress="camera"]')).toHaveText(/^\d+ dtk$/);
  const bar = analysis.getByRole("progressbar", { name: "Analisis wajah" });
  await expect(bar).not.toHaveAttribute("value", /.*/); // indeterminate: never a made-up percentage
  await expect.poll(() => layoutOf(page), { timeout: 15_000 }).toBe("camera");
});

test("choosing another layout while the faces are analysed keeps that choice", async ({ page }) => {
  const panel = await openLayoutPanel(page, { prepareMs: 2000 });
  await radio(panel, "Ikuti wajah").check();
  await expect(panel.locator("[data-layout-analysis]")).toBeVisible();
  await radio(panel, "Potong tengah").check();
  await expect.poll(() => layoutOf(page)).toBe("fill_center");
  await expect(panel.locator("[data-layout-analysis]")).toBeHidden();
  await page.waitForTimeout(2500); // the analysis finishes in the background
  expect(await layoutOf(page)).toBe("fill_center");
  expect((await calls(page)).filter((entry) => entry[0] === "dispatch").map((entry) => entry[2].mode)).toEqual(["fill_center"]);
  await expect(radio(panel, "Potong tengah")).toBeChecked();
});

test("a failed analysis says so, keeps the layout and can be tried again", async ({ page }) => {
  const panel = await openLayoutPanel(page, { prepareMs: 300, prepareFails: 1 });
  await radio(panel, "Ikuti wajah").check();
  const alert = panel.getByRole("alert");
  await expect(alert).toContainText("Analisis wajah gagal: Layanan editor sedang tidak tersedia; coba lagi sebentar lagi");
  expect(await layoutOf(page)).toBe("fit_blur");
  await expect(radio(panel, "Latar blur")).toBeChecked();
  await alert.getByRole("button", { name: "Coba lagi" }).click();
  await expect.poll(() => layoutOf(page), { timeout: 15_000 }).toBe("camera");
  await expect(panel.getByRole("alert")).toHaveCount(0);
});

test("the runs without a face are listed with jump-to, only for face-track", async ({ page }) => {
  const panel = await openLayoutPanel(page, { cameraSeed: true, noFace: [200, 45, 45] });
  await expect(radio(panel, "Ikuti wajah")).toBeChecked();
  const list = panel.locator("[data-layout-noface]");
  await expect(list.getByRole("heading", { name: "Tanpa wajah terdeteksi (2)" })).toBeVisible();
  await expect(list).toContainText("Di bagian ini video dipusatkan.");
  const jumps = list.getByRole("button");
  await expect(jumps).toHaveText(["Lompat ke 00:01,5", "Lompat ke 00:06,6"]);
  await jumps.nth(1).click();
  await expect.poll(() => page.evaluate(() => window.__potonginEditor.player.frame())).toBe(200);
  await expect(page.getByTestId("stage-time")).toContainText("00:06,6");
  // other layouts have no list; back on face-track it returns, and the seed names its camera
  // plan, so nothing is analysed
  await radio(panel, "Latar blur").check();
  await expect.poll(() => layoutOf(page)).toBe("fit_blur");
  await expect(panel.locator("[data-layout-noface]")).toHaveCount(0);
  await radio(panel, "Ikuti wajah").check();
  await expect.poll(() => layoutOf(page)).toBe("camera");
  await expect(list.getByRole("button")).toHaveCount(2);
  expect((await calls(page)).filter((entry) => entry[0] === "prepare")).toEqual([]);
});

test("face-track with every face found says so", async ({ page }) => {
  const panel = await openLayoutPanel(page, { cameraSeed: true, noFace: [] });
  await expect(panel.locator("[data-layout-noface]")).toContainText("Wajah terdeteksi di seluruh klip.");
  await expect(panel.locator("[data-layout-noface]").getByRole("button")).toHaveCount(0);
});

test("a face-track document without its camera plan is analysed on its own", async ({ page }) => {
  // e.g. a draft restored after the camera plan was removed: the plan request answers analysis_missing
  const panel = await openLayoutPanel(page, { docPatch: { "layout.default.mode": "camera" }, prepareMs: 800 },
    { planned: false });
  await expect(radio(panel, "Ikuti wajah")).toBeChecked();
  await expect(panel.locator("[data-layout-analysis]")).toContainText("Menganalisis wajah…");
  await expect.poll(async () => (await calls(page)).filter((entry) => entry[0] === "prepare")).toEqual([["prepare", { layout: "camera" }]]);
  await expect.poll(() => page.evaluate(() => window.__potonginEditor.store.getState().previewError), { timeout: 15_000 }).toBe(null);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible();
  await expect(panel.locator("[data-layout-analysis]")).toBeHidden();
  expect((await calls(page)).filter((entry) => entry[0] === "dispatch")).toEqual([]);
  expect(await layoutOf(page)).toBe("camera");
});

test("read-only: the layouts are shown but cannot be changed", async ({ page }) => {
  const panel = await openLayoutPanel(page, { readOnly: "transcript_changed" });
  await expect(panel.getByRole("radio")).toHaveCount(3);
  for (const name of ["Latar blur", "Ikuti wajah", "Potong tengah"]) await expect(radio(panel, name)).toBeDisabled();
  await expect(radio(panel, "Latar blur")).toBeChecked();
});

test("the choices work from the keyboard", async ({ page }) => {
  const panel = await openLayoutPanel(page);
  await radio(panel, "Latar blur").focus();
  await page.keyboard.press("ArrowUp"); // wraps to the last option: Potong tengah
  await expect.poll(() => layoutOf(page)).toBe("fill_center");
  await expect(radio(panel, "Potong tengah")).toBeFocused();
});

test("QG-A11Y: axe finds no critical or serious violation in the layout panel", async ({ page }) => {
  test.skip(!AXE, "axe-core is not a web dependency yet: set AXE_CORE_PATH to an axe.min.js");
  const panel = await openLayoutPanel(page, { cameraSeed: true, noFace: [45, 200] });
  const check = async () => {
    await page.addScriptTag({ content: AXE });
    const violations = await page.evaluate(async () => {
      const result = await window.axe.run(document.querySelector('[data-panel="layout"]'), { resultTypes: ["violations"] });
      return result.violations.map((violation) => ({ id: violation.id, impact: violation.impact }));
    });
    return violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
  };
  await expect(panel.locator("[data-layout-noface]")).toBeVisible();
  expect(await check()).toEqual([]);
  await radio(panel, "Potong tengah").check();
  await expect.poll(() => layoutOf(page)).toBe("fill_center");
  expect(await check()).toEqual([]);
});
