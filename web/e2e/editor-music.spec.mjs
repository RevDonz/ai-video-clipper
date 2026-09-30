// The Musik panel and the music lane (plan §11.3 T3.3, §5.6, Appendix B, Appendix C.3), against the
// editor fakes: add, replace and remove music; volume, start, loop and fades; ducking with the
// Halus/Sedang/Kuat presets and the detail sliders; the clip's own volume; normalize with the
// reached loudness; the peak_reduced, loudness_clamped and music-shorter notes; the one-time
// copyright notice; upload errors; the lane's envelope (point for point from the plan) and
// waveform; keyboard reach; scripted QG-UX U5 (music part). The commands the panel sent are
// replayed through the real commands (web/lib/editor/commands.mjs) in Node and must give the
// document the browser shows.
//
// Prerequisites (as web/e2e/editor-shell.spec.mjs):
//   - a server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1, E2E_USERNAME/E2E_PASSWORD;
//   - E2E_EDITOR_FAKES=1 to run the panel tests;
//   - optional: AXE_CORE_PATH=<axe.min.js>; EDITOR_GATES=1 and EDITOR_GATES_OUT=<dir> for the U5
//     timing evidence.
// The browser half of P-AUD (the last block) needs MUSIC_PAUD_FIXTURES=<dir> made by
// `scripts/parity/audio_gates.py p-aud --browser-fixtures <dir>`; it runs on any server page.
import { expect, test as base } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { FAKE_CLIP_ID, FAKE_JOB_ID, fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext, musicItem } from "../lib/editor/doc-model.mjs";
import { login, settings } from "./support/harness.mjs";

const EDITOR = `/projects/${FAKE_JOB_ID}/clips/${FAKE_CLIP_ID}/edit`;
const U5_LIMIT_MS = 60_000; // plan §10.2 QG-UX U5: logo and ducked music together
const P_AUD_MAX_LSB = 1;
const gatesOut = process.env.EDITOR_GATES_OUT || "";
const runGates = process.env.EDITOR_GATES === "1";
const pAudDir = process.env.MUSIC_PAUD_FIXTURES || "";

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

// 95 s of synthetic peaks (the fake upload's duration): a slow swell, as §5.7 byte pairs.
function fakePeaks() {
  const bins = 9500;
  const bytes = Buffer.alloc(bins * 2);
  for (let i = 0; i < bins; i += 1) {
    const level = Math.round(40 + 60 * Math.abs(Math.sin(i / 70)));
    bytes.writeInt8(-level, 2 * i);
    bytes.writeInt8(level, 2 * i + 1);
  }
  return bytes;
}
const PEAKS = fakePeaks();

// ---------------------------------------------------------------------------------------------
// Browser-side scenario (serialised by addInitScript). The store applies the music commands the
// way web/lib/editor/commands.mjs does (the cross-check test proves it), the preview client adds
// the audio part of the plan DTO (§4.3), and `uploadAsset` is the fake upload of Appendix A.2.
function installMusicScenario(config) {
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const DUCK = { on: true, depth_cdb: 1000, attack_ms: 30, release_ms: 400, hold_ms: 250, detector: "words" };
  const PRESETS = { halus: 600, sedang: 1000, kuat: 1600 };
  const RATE = 48000;
  const uploads = [];
  window.__musicUploads = uploads;

  const musicTrack = (doc) => doc.tracks.find((track) => track.kind === "audio") ?? null;
  const itemOf = (doc) => musicTrack(doc)?.items[0] ?? null;
  const assetId = (asset, meta) => {
    const id = typeof asset === "string" ? asset : meta.sha256;
    return /^[0-9a-f]{64}$/.test(id) ? `sha256:${id}` : id;
  };
  const syncAssets = (doc) => {
    const assets = {};
    for (const track of doc.tracks) for (const item of track.items) {
      if (typeof item.payload?.asset === "string") assets[item.payload.asset] = doc.assets[item.payload.asset];
    }
    doc.assets = assets;
  };
  const reducers = {
    SetMusic(doc, { asset, meta }) {
      const id = assetId(asset, meta);
      const lufs = meta.lufs_c ?? meta.lufsC;
      const previous = musicTrack(doc);
      const item = {
        id: previous?.items[0]?.id ?? "it_music", type: "audio", start: { at: "clip_start" }, end: { at: "clip_end" },
        payload: { asset: id, src_in_smp: 0, loop: true, gain_cdb: Math.min(600, Math.max(-4800, -2600 - lufs)),
          fade_in_f: 15, fade_out_f: 30, duck: { ...DUCK } },
        origin: "user",
      };
      doc.tracks = doc.tracks.filter((track) => track.kind !== "audio");
      doc.tracks.push({ id: previous?.id ?? "tr_mus", kind: "audio", role: "music", items: [item] });
      doc.assets[id] = { kind: "audio", mime: meta.mime, duration_ms: meta.duration_ms ?? meta.durationMs, lufs_c: lufs };
      syncAssets(doc);
    },
    RemoveMusic(doc) { doc.tracks = doc.tracks.filter((track) => track.kind !== "audio"); syncAssets(doc); },
    SetMusicGain(doc, { gain_cdb: gain }) { itemOf(doc).payload.gain_cdb = gain; },
    SetMusicOffset(doc, { src_in_smp: offset }) { itemOf(doc).payload.src_in_smp = offset; },
    SetMusicLoop(doc, { loop }) { itemOf(doc).payload.loop = loop; },
    SetMusicFades(doc, args) { Object.assign(itemOf(doc).payload, args); },
    SetDuck(doc, { preset, ...rest }) {
      const duck = itemOf(doc).payload.duck;
      if (preset !== undefined) Object.assign(duck, { on: true, depth_cdb: PRESETS[preset] });
      Object.assign(duck, rest);
    },
    SetSourceGain(doc, { gain_cdb: gain }) { doc.audio.source.gain_cdb = gain; },
    SetLoudness(doc, { mode }) { doc.audio.master.mode = mode; },
  };

  // A stand-in for the server's music envelope: fades plus one duck span at [2 s, 4 s).
  function gainPoints(doc, samples) {
    const item = itemOf(doc);
    if (!item) return [];
    const p = item.payload;
    const g = Math.round(10 ** (p.gain_cdb / 2000) * 1e6);
    const ducked = p.duck.on ? Math.round(g * 10 ** (-p.duck.depth_cdb / 2000)) : g;
    const fi = Math.floor((p.fade_in_f * RATE * 1001) / 30000);
    const fo = samples - Math.floor((p.fade_out_f * RATE * 1001) / 30000);
    const out = [[0, fi > 0 ? 0 : g]];
    if (fi > 0) out.push([fi, g]);
    out.push([2 * RATE - (p.duck.attack_ms * RATE) / 1000, g], [2 * RATE, ducked], [4 * RATE, ducked],
      [4 * RATE + (p.duck.release_ms * RATE) / 1000, g]);
    if (fo < samples) out.push([fo, g]);
    out.push([samples, fo < samples ? 0 : g]);
    return out.map(([s, v]) => [Math.round(s), v]).filter((point, index, all) => index === 0 || point[0] > all[index - 1][0]);
  }

  function audioPart(doc, dto, ready) {
    const item = itemOf(doc);
    const warnings = [...dto.warnings];
    if (item && !item.payload.loop) {
      const meta = doc.assets[item.payload.asset];
      if (meta.duration_ms * 48 - item.payload.src_in_smp < dto.audio.samples) {
        warnings.push({ code: "music_shorter_than_clip", path: "/tracks/1/items/0" });
      }
    }
    if (ready && config.peakReduced && (item || doc.audio.source.gain_cdb > 0)) warnings.push({ code: config.peakReduced, path: "/audio" });
    if (ready && config.clamped && doc.audio.master.mode === "normalize") warnings.push({ code: config.clamped, path: "/audio/master" });
    return { ...dto, warnings, audio: { ...dto.audio, state: ready ? "ready" : "queued",
      musicGainPoints: gainPoints(doc, dto.audio.samples) } };
  }

  function musicStore(fakes, parts) {
    const listeners = new Set();
    const past = [];
    const future = [];
    let seq = 0;
    let state = { status: "loading", doc: null, seed: null, words: null, etag: null, revision: 0, save: "saved",
      savedAtMs: null, canUndo: false, canRedo: false, plan: null, pending: [], warnings: [], selection: null, commands: [],
      conflict: null, readOnlyReason: null };
    const set = (patch) => {
      state = { ...state, ...patch, canUndo: past.length > 0, canRedo: future.length > 0 };
      for (const listener of [...listeners]) listener(state);
    };
    const replan = async (doc) => {
      const mine = ++seq;
      set({ pending: ["text"] });
      const dto = await parts.previewClient.plan(doc);
      if (mine !== seq) return;
      if (!config.audioMs) { set({ plan: audioPart(doc, dto, true), pending: [] }); return; }
      set({ plan: audioPart(doc, dto, false), pending: ["audio"] });
      await wait(config.audioMs);
      if (mine === seq) set({ plan: audioPart(doc, dto, true), pending: [] });
    };
    const store = {
      getState: () => state,
      dispatch(type, args = {}, options = {}) {
        if (!fakes.COMMANDS.includes(type)) throw new fakes.CommandRejected("unknown_command");
        if (state.status !== "ready") throw new fakes.CommandRejected("read_only");
        const next = clone(state.doc);
        reducers[type]?.(next, clone(args));
        next.audit.last_command = type;
        past.push(state.doc);
        future.length = 0;
        set({ doc: next, save: "dirty", commands: [...state.commands, { type, args: clone(args), mergeKey: options.mergeKey ?? null }] });
        replan(next);
        return next;
      },
      undo() { if (!past.length) return; future.push(state.doc); const doc = past.pop(); set({ doc }); replan(doc); },
      redo() { if (!future.length) return; past.push(state.doc); const doc = future.pop(); set({ doc }); replan(doc); },
      async flush() { set({ save: "saved", savedAtMs: Date.now() }); },
      resolveConflict() {},
      startFromSeed() {},
      dismissNotice() {},
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      destroy() { listeners.clear(); },
    };
    (async () => {
      const edit = await parts.api.getEdit({ seed: false });
      const words = await parts.api.words(edit.words.url);
      const doc = edit.doc;
      if (config.startWithMusic) {
        reducers.SetMusic(doc, { asset: "c".repeat(64), meta: { kind: "music", mime: "audio/mp4", durationMs: 95000, lufsC: -1620 } });
      }
      set({ status: config.readOnly ? "readOnly" : "ready", readOnlyReason: config.readOnly ? "transcript_changed" : null,
        doc, seed: clone(edit.doc), words, etag: edit.etag });
      await replan(doc);
    })();
    return store;
  }

  async function uploadAsset(jobId, file, kind, { onProgress = () => {}, signal } = {}) {
    uploads.push({ jobId, name: file.name, type: file.type, size: file.size, kind });
    const spec = config.upload ?? {};
    for (const part of [0.25, 0.5, 1]) {
      await wait(spec.stepMs ?? 30);
      if (signal?.aborted) {
        const error = new Error("upload aborted");
        error.name = "AbortError";
        throw error;
      }
      onProgress(part);
    }
    if (spec.failStatus) throw Object.assign(new Error("upload failed"), { status: spec.failStatus, code: spec.failCode });
    const sha = Array.from({ length: 64 }, (_, i) => "0123456789abcdef"[(file.name.length * 7 + i * 3) % 16]).join("");
    return { sha256: sha, kind: "music", mime: "audio/mp4", w: null, h: null, durationMs: spec.durationMs ?? 95000,
      lufsC: spec.lufsC ?? -1620, peaksUrl: `/api/jobs/${jobId}/assets/${sha}?part=peaks` };
  }

  window.__potonginEditorScenario = {
    previewClient(client) { return client; },
    store(store, fakes, parts) { store.destroy(); return musicStore(fakes, parts); },
    uploadAsset,
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
    // The asset store's peaks route (T3.1, §4.2 `GET /assets/:sha?part=peaks`), faked at the network.
    await page.route("**/api/jobs/*/assets/*", (route) => {
      if (new URL(route.request().url()).searchParams.get("part") !== "peaks") return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: "application/octet-stream", body: PEAKS });
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

async function openMusic(page, config = {}) {
  await page.addInitScript(installMusicScenario, config);
  await page.goto(EDITOR);
  await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
  await page.getByRole("tab", { name: "Musik" }).click();
  await expect(page.locator('[data-panel="music"]')).toBeVisible();
}

const state = (page) => page.evaluate(() => {
  const current = window.__potonginEditor.store.getState();
  return { status: current.status, doc: current.doc, commands: current.commands, plan: current.plan, pending: current.pending };
});
const payloadOf = async (page) => {
  const { doc } = await state(page);
  return doc.tracks.find((track) => track.kind === "audio")?.items[0]?.payload ?? null;
};
const lastCommand = async (page) => (await state(page)).commands.at(-1);
const panel = (page) => page.locator('[data-panel="music"]');
const musicName = (page) => panel(page).locator("[data-music-name]");

async function addMusic(page, name = "lagu-latar.m4a", { notice = false } = {}) {
  const chooser = page.waitForEvent("filechooser");
  await panel(page).getByRole("button", { name: "Tambah musik" }).click();
  if (notice) {
    await expect(panel(page).getByText(/Content ID/)).toBeVisible();
    await panel(page).getByRole("button", { name: "Pilih file musik" }).click();
  }
  const fileChooser = await chooser;
  await fileChooser.setFiles({ name, mimeType: "audio/mp4", buffer: Buffer.from("fake m4a bytes") });
}

async function slide(page, name, keys) {
  const slider = panel(page).getByRole("slider", { name, exact: true });
  await slider.focus();
  for (const key of keys) await page.keyboard.press(key);
  return slider;
}

// ---------------------------------------------------------------------------------------------

test.describe("Musik panel on the fakes", () => {
  test.skip(process.env.E2E_EDITOR_FAKES !== "1",
    "E2E_EDITOR_FAKES=1 is required (server with POTONGIN_EDITOR_V3=on and POTONGIN_EDITOR_FAKES=1)");
  test.skip(!settings.username || !settings.password, "E2E_USERNAME and E2E_PASSWORD are required");

  test("adding music: the copyright notice once, upload progress, then SetMusic with the store's defaults", async ({ page }) => {
    await openMusic(page, { upload: { stepMs: 250 } });
    await expect(panel(page).getByText("Belum ada musik")).toBeVisible();
    await expect(page.locator('[data-lane="music"]')).toContainText("Tidak ada musik");
    await addMusic(page, "lagu-latar.m4a", { notice: true });
    await expect(panel(page).getByRole("progressbar", { name: /Mengunggah lagu-latar\.m4a/ })).toBeVisible();
    await expect(musicName(page)).toHaveText("lagu-latar.m4a", { timeout: 10_000 });
    const command = await lastCommand(page);
    expect(command.type).toBe("SetMusic");
    expect(command.args.meta).toMatchObject({ kind: "music", mime: "audio/mp4", durationMs: 95000, lufsC: -1620 });
    const uploads = await page.evaluate(() => window.__musicUploads);
    expect(uploads).toEqual([{ jobId: FAKE_JOB_ID, name: "lagu-latar.m4a", type: "audio/mp4", size: 14, kind: "music" }]);
    const payload = await payloadOf(page);
    expect(payload).toMatchObject({ gain_cdb: -980, loop: true, fade_in_f: 15, fade_out_f: 30, src_in_smp: 0 });
    await expect(panel(page).getByRole("slider", { name: "Volume musik", exact: true })).toHaveAttribute("aria-valuetext", "−9,8 dB");
    await expect(panel(page).getByRole("radio", { name: /Sedang/ })).toBeChecked();
    await expect(panel(page).getByRole("switch", { name: "Kecilkan musik saat ada suara" })).toBeChecked();
    await expect(panel(page).locator("[data-music-duration]")).toHaveText("1:35");
    // Normalize is off by default (K9) and suggested once music is in.
    await expect(panel(page).getByRole("switch", { name: /Samakan kenyaringan/ })).not.toBeChecked();
    await expect(panel(page).getByText(/Disarankan saat ada musik/)).toBeVisible();

    // The notice is one-time: removing and adding again opens the file picker at once, also after a reload.
    await panel(page).getByRole("button", { name: "Hapus musik" }).click();
    await expect(panel(page).getByText("Belum ada musik")).toBeVisible();
    await addMusic(page, "kedua.mp3");
    await expect(musicName(page)).toHaveText("kedua.mp3", { timeout: 10_000 });
    await page.reload();
    await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Musik" }).click();
    await addMusic(page, "ketiga.mp3");
    await expect(musicName(page)).toHaveText("ketiga.mp3", { timeout: 10_000 });
  });

  test("every control dispatches its command and shows the value it set", async ({ page }) => {
    await openMusic(page, { startWithMusic: true });
    await expect(musicName(page)).toHaveText("Musik terunggah");

    await slide(page, "Volume musik", ["ArrowLeft", "ArrowLeft"]);
    expect(await lastCommand(page)).toMatchObject({ type: "SetMusicGain", mergeKey: "music:gain" });
    expect((await payloadOf(page)).gain_cdb).toBe(-1000);
    await expect(panel(page).getByRole("slider", { name: "Volume musik", exact: true })).toHaveAttribute("aria-valuetext", "−10,0 dB");
    await panel(page).getByRole("button", { name: "Kembalikan volume musik" }).click();
    expect((await payloadOf(page)).gain_cdb).toBe(-980);

    await slide(page, "Mulai dari", ["ArrowRight", "ArrowRight", "ArrowRight"]);
    expect(await lastCommand(page)).toMatchObject({ type: "SetMusicOffset", mergeKey: "music:offset" });
    expect((await payloadOf(page)).src_in_smp).toBe(3 * 4800);
    await expect(panel(page).getByRole("slider", { name: "Mulai dari", exact: true })).toHaveAttribute("aria-valuetext", "0:00,3");

    await panel(page).getByRole("switch", { name: "Ulangi sampai klip selesai" }).click();
    expect(await lastCommand(page)).toMatchObject({ type: "SetMusicLoop", args: { loop: false } });

    await slide(page, "Muncul perlahan", ["Home"]);
    expect(await lastCommand(page)).toMatchObject({ type: "SetMusicFades", args: { fade_in_f: 0 }, mergeKey: "music:fades" });
    await slide(page, "Hilang perlahan", ["End"]);
    expect((await payloadOf(page)).fade_out_f).toBe(299);
    await expect(panel(page).getByRole("slider", { name: "Hilang perlahan", exact: true })).toHaveAttribute("aria-valuetext", "10,0 dtk");

    await panel(page).getByRole("radio", { name: /Kuat/ }).check();
    expect(await lastCommand(page)).toMatchObject({ type: "SetDuck", args: { preset: "kuat" }, mergeKey: "music:duck" });
    expect((await payloadOf(page)).duck.depth_cdb).toBe(1600);
    await panel(page).getByRole("radio", { name: /Halus/ }).check();
    expect((await payloadOf(page)).duck.depth_cdb).toBe(600);

    await panel(page).getByText("Atur detail").click();
    await slide(page, "Kedalaman", ["ArrowRight", "ArrowRight"]);
    expect((await payloadOf(page)).duck.depth_cdb).toBe(700);
    await expect(panel(page).getByRole("radio", { name: /Halus/ })).not.toBeChecked();
    await expect(panel(page).getByText("Kustom: −7,0 dB")).toBeVisible();
    await slide(page, "Waktu turun", ["ArrowRight"]);
    expect((await payloadOf(page)).duck.attack_ms).toBe(35);
    await slide(page, "Waktu naik", ["ArrowLeft"]);
    expect((await payloadOf(page)).duck.release_ms).toBe(350);
    await slide(page, "Jeda tahan", ["Home"]);
    expect((await payloadOf(page)).duck.hold_ms).toBe(0);

    await panel(page).getByRole("switch", { name: "Kecilkan musik saat ada suara" }).click();
    expect(await lastCommand(page)).toMatchObject({ type: "SetDuck", args: { on: false } });
    await expect(panel(page).getByRole("radio", { name: /Sedang/ })).toBeDisabled();

    await slide(page, "Volume suara asli", ["ArrowRight", "ArrowRight"]);
    expect(await lastCommand(page)).toMatchObject({ type: "SetSourceGain", mergeKey: "audio:source" });
    expect((await state(page)).doc.audio.source.gain_cdb).toBe(100);

    await panel(page).getByRole("switch", { name: /Samakan kenyaringan/ }).click();
    expect(await lastCommand(page)).toMatchObject({ type: "SetLoudness", args: { mode: "normalize" }, mergeKey: "audio:master" });
    await expect(panel(page).getByText("Tercapai −14,0 LUFS")).toBeVisible();
  });

  test("replace keeps ducking, loop and fades in one undo step; remove clears the lane", async ({ page }) => {
    await openMusic(page, { startWithMusic: true });
    await panel(page).getByRole("radio", { name: /Kuat/ }).check();
    await panel(page).getByRole("switch", { name: "Ulangi sampai klip selesai" }).click();
    const before = (await state(page)).commands.length;
    const chooser = page.waitForEvent("filechooser");
    await panel(page).getByRole("button", { name: "Ganti musik" }).click();
    await expect(panel(page).getByText(/Content ID/)).toBeVisible();
    await panel(page).getByRole("button", { name: "Pilih file musik" }).click();
    await (await chooser).setFiles({ name: "pengganti.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("fake mp3") });
    await expect(musicName(page)).toHaveText("pengganti.mp3", { timeout: 10_000 });
    const sent = (await state(page)).commands.slice(before);
    expect(sent.map((command) => command.type)).toEqual(["SetMusic", "SetMusicLoop", "SetDuck"]);
    expect(new Set(sent.map((command) => command.mergeKey)).size).toBe(1);
    expect(await payloadOf(page)).toMatchObject({ loop: false, duck: { depth_cdb: 1600, on: true } });

    await panel(page).getByRole("button", { name: "Hapus musik" }).click();
    expect(await lastCommand(page)).toMatchObject({ type: "RemoveMusic" });
    await expect(page.locator('[data-lane="music"]')).toContainText("Tidak ada musik");
    await expect(panel(page).getByRole("slider", { name: "Volume musik", exact: true })).toHaveCount(0);
    await expect(panel(page).getByRole("slider", { name: "Volume suara asli", exact: true })).toBeVisible();
  });

  test("the lane draws the plan's envelope point for point and the waveform from the asset's peaks", async ({ page }) => {
    await openMusic(page, { startWithMusic: true });
    const envelope = page.locator('[data-lane="music"] [data-music-envelope]');
    await expect(envelope).toHaveCount(1);
    const check = async () => {
      const { plan } = await state(page);
      const px = Number(await page.locator('[data-slot="timeline"]').getAttribute("data-px-per-frame"));
      const height = Number(await envelope.getAttribute("data-height"));
      const ref = Number(await envelope.getAttribute("data-ref-e6"));
      const drawn = (await envelope.getAttribute("points")).trim().split(/\s+/).map((pair) => pair.split(",").map(Number));
      const [num, den] = plan.fps;
      const floor = -40;
      const expected = plan.audio.musicGainPoints.map(([sample, gain]) => {
        const db = gain > 0 ? Math.min(0, Math.max(floor, 20 * Math.log10(gain / ref))) : floor;
        return [(sample * num * px) / (48000 * den), gain > 0 ? (db / floor) * height : height];
      });
      expect(drawn.length).toBe(expected.length);
      drawn.forEach(([x, y], i) => {
        expect(Math.abs(x - expected[i][0])).toBeLessThan(0.01);
        expect(Math.abs(y - expected[i][1])).toBeLessThan(0.01);
      });
      return drawn;
    };
    const sedang = await check();
    await expect(page.locator('[data-lane="music"] [data-music-wave]')).toHaveAttribute("d", /^M/);
    await panel(page).getByRole("radio", { name: /Kuat/ }).check();
    await expect.poll(async () => (await state(page)).plan.audio.musicGainPoints[3]?.[1]).toBe(Math.round(Math.round(10 ** (-980 / 2000) * 1e6) * 10 ** (-1600 / 2000)));
    const kuat = await check();
    expect(kuat[3][1]).toBeGreaterThan(sedang[3][1]); // deeper duck: lower on the lane
    // A click on the lane moves the playhead there.
    const box = await page.locator('[data-lane="music"]').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => page.evaluate(() => window.__potonginEditor.player.frame())).toBeGreaterThan(100);
  });

  test("notes: music shorter than the clip, peak reduced, loudness clamped, measuring", async ({ page }) => {
    await openMusic(page, { startWithMusic: true, upload: { durationMs: 4000 }, peakReduced: "peak_reduced:-3.80 dB",
      clamped: "loudness_clamped:-16.30 LUFS", audioMs: 600 });
    await expect(panel(page).getByText("Volume diturunkan 3,8 dB agar tidak pecah")).toBeVisible();
    const chooser = page.waitForEvent("filechooser");
    await panel(page).getByRole("button", { name: "Ganti musik" }).click();
    await panel(page).getByRole("button", { name: "Pilih file musik" }).click();
    await (await chooser).setFiles({ name: "pendek.wav", mimeType: "audio/wav", buffer: Buffer.from("fake wav") });
    await expect(musicName(page)).toHaveText("pendek.wav", { timeout: 10_000 });
    await expect(panel(page).getByText(/Musik lebih pendek dari klip/)).toHaveCount(0);
    await panel(page).getByRole("switch", { name: "Ulangi sampai klip selesai" }).click();
    await expect(panel(page).getByText(/Musik lebih pendek dari klip/)).toBeVisible();
    await panel(page).getByRole("switch", { name: /Samakan kenyaringan/ }).click();
    await expect(panel(page).getByText("Mengukur…")).toBeVisible();
    await expect(panel(page).getByText("Tercapai −16,3 LUFS: dibatasi agar tidak pecah")).toBeVisible();
    await expect(panel(page).getByText("Menyiapkan audio…")).toHaveCount(0);
  });

  test("upload errors: wrong type and too large are caught before sending; server rejections, cancel and uploads off have their message", async ({ page }) => {
    await openMusic(page, { upload: { stepMs: 400, failStatus: 422, failCode: "asset_rejected" } });
    await page.evaluate(() => { try { localStorage.setItem("potongin-editor-music-notice", "1"); } catch { /* private mode */ } });
    let chooser = page.waitForEvent("filechooser");
    await panel(page).getByRole("button", { name: "Tambah musik" }).click();
    await (await chooser).setFiles({ name: "gambar.png", mimeType: "image/png", buffer: Buffer.from("png") });
    await expect(panel(page).getByRole("alert")).toContainText("MP3, M4A, WAV, OGG atau FLAC");
    expect(await page.evaluate(() => window.__musicUploads.length)).toBe(0);

    chooser = page.waitForEvent("filechooser");
    await panel(page).getByRole("button", { name: "Tambah musik" }).click();
    await (await chooser).setFiles({ name: "rusak.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("broken") });
    await expect(panel(page).getByRole("alert")).toContainText("tidak bisa dibaca sebagai musik");
    expect((await state(page)).commands.length).toBe(0);

    chooser = page.waitForEvent("filechooser");
    await panel(page).getByRole("button", { name: "Tambah musik" }).click();
    await (await chooser).setFiles({ name: "lambat.mp3", mimeType: "audio/mpeg", buffer: Buffer.from("slow") });
    await panel(page).getByRole("button", { name: "Batalkan unggahan" }).click();
    await expect(panel(page).getByText("Unggahan dibatalkan.")).toBeVisible();
    expect((await state(page)).commands.length).toBe(0);
  });

  test("a file over 50 MB never leaves the browser", async ({ page }) => {
    await openMusic(page);
    const chooser = page.waitForEvent("filechooser");
    await panel(page).getByRole("button", { name: "Tambah musik" }).click();
    await panel(page).getByRole("button", { name: "Pilih file musik" }).click();
    // A sparse 50 MB + 1 byte file: setFiles reads a path, so write one to the temp dir.
    const big = path.join(os.tmpdir(), `potongin-music-${process.pid}.mp3`);
    writeFileSync(big, Buffer.alloc(50 * 1024 * 1024 + 1));
    try {
      await (await chooser).setFiles(big);
    } finally {
      rmSync(big, { force: true });
    }
    await expect(panel(page).getByRole("alert")).toContainText("50 MB");
    expect(await page.evaluate(() => window.__musicUploads.length)).toBe(0);
  });

  test("uploads switched off on the server say so", async ({ page }) => {
    await openMusic(page, { upload: { failStatus: 404, failCode: "editor_disabled" } });
    await addMusic(page, "lagu.mp3", { notice: true });
    await expect(panel(page).getByRole("alert")).toContainText("Unggah file belum diaktifkan");
  });

  test("a read-only clip disables every control of the panel", async ({ page }) => {
    await openMusic(page, { startWithMusic: true, readOnly: true });
    const controls = panel(page).locator("button, input, select, textarea");
    const count = await controls.count();
    expect(count).toBeGreaterThan(8);
    for (let i = 0; i < count; i += 1) {
      const control = controls.nth(i);
      if (await control.evaluate((element) => element.closest("details") && !element.closest("details").open)) continue;
      await expect(control).toBeDisabled();
    }
  });

  test("keyboard: every control is reachable with Tab and shows a focus ring; no overflow at 1366×768; axe", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 768 });
    await openMusic(page, { startWithMusic: true });
    await panel(page).getByText("Atur detail").click();
    // One tab stop per control; a radio group is one stop (arrow keys move inside it).
    const expected = await panel(page).evaluate((root) => {
      const groups = new Set();
      let stops = 0;
      for (const node of root.querySelectorAll("button, input, summary")) {
        if (node.disabled || node.type === "file" || node.closest("[hidden]")) continue;
        if (node.type === "radio") {
          if (!groups.has(node.name)) { groups.add(node.name); stops += 1; }
        } else stops += 1;
      }
      return stops;
    });
    await panel(page).getByRole("button", { name: "Ganti musik" }).focus();
    const reached = new Set();
    for (let i = 0; i < expected + 6; i += 1) {
      const info = await page.evaluate(() => {
        const element = document.activeElement;
        const inside = Boolean(element?.closest('[data-panel="music"]'));
        // The ring is on the control, on its label (cards) or on the drawn track beside a switch.
        const drawn = (node) => {
          if (!node) return false;
          const style = getComputedStyle(node);
          return (style.outlineStyle !== "none" && style.outlineWidth !== "0px") || style.boxShadow !== "none";
        };
        const ring = Boolean(element) && [element, element.closest("label"), element.nextElementSibling].some(drawn);
        const box = element?.getBoundingClientRect();
        return { inside, ring, key: element ? `${element.tagName}:${element.getAttribute("aria-label") ?? element.id ?? ""}:${box?.x},${box?.y}` : null };
      });
      if (!info.inside) break;
      expect(info.ring, info.key).toBe(true);
      reached.add(info.key);
      await page.keyboard.press("Tab");
    }
    expect(reached.size).toBeGreaterThanOrEqual(expected);
    const overflow = await panel(page).evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    if (AXE) {
      await page.addScriptTag({ content: AXE });
      const result = await page.evaluate(() => window.axe.run('[data-panel="music"]', { resultTypes: ["violations"] }));
      const serious = result.violations.filter((violation) => ["critical", "serious"].includes(violation.impact));
      expect(serious.map((violation) => violation.id)).toEqual([]);
    }
  });

  test("the commands the panel sent give the browser's document through the real commands", async ({ page }) => {
    await openMusic(page);
    await addMusic(page, "silang.m4a", { notice: true });
    await expect(musicName(page)).toHaveText("silang.m4a", { timeout: 10_000 });
    await slide(page, "Volume musik", ["ArrowRight", "ArrowRight", "ArrowRight"]);
    await slide(page, "Mulai dari", ["ArrowRight"]);
    await panel(page).getByRole("switch", { name: "Ulangi sampai klip selesai" }).click();
    await slide(page, "Muncul perlahan", ["ArrowLeft", "ArrowLeft"]);
    await panel(page).getByRole("radio", { name: /Kuat/ }).check();
    await panel(page).getByText("Atur detail").click();
    await slide(page, "Waktu naik", ["End"]);
    await slide(page, "Jeda tahan", ["ArrowRight"]);
    await slide(page, "Volume suara asli", ["ArrowLeft"]);
    await panel(page).getByRole("switch", { name: /Samakan kenyaringan/ }).click();
    const browser = await state(page);
    const ctx = createContext({ words: fakeWords(), seed: fakeDoc() });
    let doc = fakeDoc();
    for (const command of browser.commands) doc = applyCommand(doc, command.type, command.args, ctx).doc;
    expect(musicItem(doc)).toEqual(musicItem(browser.doc));
    expect(doc.assets).toEqual(browser.doc.assets);
    expect(doc.audio).toEqual(browser.doc.audio);
  });

  test("scripted QG-UX U5 (music part): add ducked music within the time limit", async ({ page }) => {
    test.skip(!runGates, "EDITOR_GATES=1 runs the timed U5 (music part)");
    await page.addInitScript(installMusicScenario, { audioMs: 400 });
    const started = Date.now();
    await page.goto(EDITOR);
    await expect(page.locator('[data-editor-ready="true"]')).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Musik" }).click();
    await addMusic(page, "u5.m4a", { notice: true });
    await expect(panel(page).getByRole("radio", { name: /Sedang/ })).toBeChecked({ timeout: 10_000 });
    await expect.poll(async () => (await state(page)).pending.length).toBe(0);
    const elapsed = Date.now() - started;
    const payload = await payloadOf(page);
    expect(payload.duck.on).toBe(true);
    writeGate("T3.3-QG-UX-U5-music.json", { gate: "QG-UX U5 (music part, scripted on the fakes)", limit_ms: U5_LIMIT_MS,
      elapsed_ms: elapsed, steps: ["open the editor", "tab Musik", "Tambah musik", "copyright notice: Pilih file musik",
        "choose the file", "upload", "ducking Sedang by default", "mix current"],
      viewport: page.viewportSize(), browser: page.context().browser()?.version() ?? null, pass: elapsed <= U5_LIMIT_MS });
    expect(elapsed).toBeLessThanOrEqual(U5_LIMIT_MS);
  });
});

// ---------------------------------------------------------------------------------------------
// P-AUD, browser half (plan §10.1): the preview FLAC of a music mix, decoded by the browser into an
// AudioContext at 48 kHz, equals the reference PCM within 1 LSB with the same sample count.

const pAudManifest = pAudDir && existsSync(path.join(pAudDir, "manifest.json"))
  ? JSON.parse(readFileSync(path.join(pAudDir, "manifest.json"), "utf8")) : null;

test.describe("P-AUD (browser half) on music mixes", () => {
  test.skip(!pAudManifest, "MUSIC_PAUD_FIXTURES must hold manifest.json (scripts/parity/audio_gates.py p-aud --browser-fixtures)");

  test("the AudioBuffer of every music mix equals the reference PCM", async ({ page }) => {
    test.setTimeout(600_000);
    await page.route("**/__music-paud/**", (route) => {
      const name = path.basename(new URL(route.request().url()).pathname);
      if (!/^[a-z0-9_.-]+$/.test(name)) return route.fulfill({ status: 404, body: "" });
      return route.fulfill({ status: 200, contentType: "application/octet-stream", body: readFileSync(path.join(pAudDir, name)) });
    });
    await page.goto("/login");
    const results = [];
    for (const item of pAudManifest.cases) {
      const check = await page.evaluate(async ({ flac, pcm }) => {
        const context = new AudioContext({ sampleRate: 48000 });
        const buffer = await context.decodeAudioData(await (await fetch(`/__music-paud/${flac}`)).arrayBuffer());
        const reference = new Int16Array(await (await fetch(`/__music-paud/${pcm}`)).arrayBuffer());
        const channels = [buffer.getChannelData(0), buffer.getChannelData(buffer.numberOfChannels > 1 ? 1 : 0)];
        const length = Math.min(buffer.length, reference.length / 2);
        let maxDiff = 0;
        let differing = 0;
        let notExact = 0;
        for (let i = 0; i < length; i += 1) {
          for (let c = 0; c < 2; c += 1) {
            const value = channels[c][i];
            const want = reference[2 * i + c];
            const delta = Math.abs(value * 32768 - want);
            if (delta > maxDiff) maxDiff = delta;
            if (delta > 0) differing += 1;
            if (Math.round(value < 0 ? value * 32768 : value * 32767) !== want) notExact += 1;
          }
        }
        const result = { contextRate: context.sampleRate, bufferRate: buffer.sampleRate, channels: buffer.numberOfChannels,
          length: buffer.length, referenceLength: reference.length / 2, maxDiffLsb: maxDiff, differingSamples: differing,
          notExactUnderInt16Scaling: notExact };
        await context.close();
        return result;
      }, item);
      results.push({ case: item.id, planSamples: item.planSamples, ...check });
    }
    const report = { gate: "P-AUD (browser half, music)", task: "T3.3", browser: page.context().browser()?.version() ?? null,
      threshold: { max_diff_lsb: P_AUD_MAX_LSB, sample_rate: 48000, same_count_as: "reference and plan" }, cases: results,
      pass: results.length > 0 && results.every((r) => r.contextRate === 48000 && r.bufferRate === 48000
        && r.length === r.referenceLength && r.length === r.planSamples && r.maxDiffLsb <= P_AUD_MAX_LSB) };
    if (process.env.MUSIC_PAUD_OUT) writeFileSync(process.env.MUSIC_PAUD_OUT, `${JSON.stringify(report, null, 2)}\n`);
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const r of results) {
      expect(r.contextRate).toBe(48000);
      expect(r.bufferRate).toBe(48000);
      expect(r.length).toBe(r.referenceLength);
      expect(r.length).toBe(r.planSamples);
      expect(r.maxDiffLsb).toBeLessThanOrEqual(P_AUD_MAX_LSB);
    }
  });
});
