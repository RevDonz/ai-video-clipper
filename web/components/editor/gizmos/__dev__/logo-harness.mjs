// Dev and test only (web/e2e/editor-logo.spec.mjs; never imported by the app). The editor shell
// runs on the real store and the real Appendix B commands over the fake API (__dev__/fakes.mjs),
// with a preview client that answers like the server for the logo (plan §3.4 box, §5.9 G5 warning),
// a player that paints the stage, and an upload client driven by the spec's scenario.
//
// Config (window.__HARNESS_CONFIG__):
//   planMs            preview latency (default 30)
//   readOnly          the clip opens read-only ("Transkrip berubah")
//   doc               the document the fake API serves (default fakes.fakeDoc())
//   upload.stepMs     delay between progress steps (default 20)
//   upload.steps      progress steps before the answer (default 4)
//   upload.processingMs  time after the last byte (T3.1's "processing" phase; default 40)
//   upload.sizes      { [file name]: [w, h] } of the normalised PNG (default 512×512)
//   upload.fail       { [file name]: { status, code, reason?, message? } | "network" }
import { HARNESS_FRAME_GRADIENT } from "../../../../lib/editor/content-colours.mjs";
import { createDraftStore } from "../../../../lib/editor/draft-store.mjs";
import { createEditorStore } from "../../../../lib/editor/store.mjs";
import { logoBox } from "../../../../lib/editor/timemap.mjs";
import {
  FAKE_CLIP_ID, FAKE_JOB_ID, createFakeApiClient, createFakePlayer, createFakeUploadClient, fakeDoc, fakePlan,
} from "../../__dev__/fakes.mjs";
import { provideLogoUploader } from "../logo-upload.mjs";

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(new DOMException("Unggahan dibatalkan", "AbortError"));
  }, { once: true });
});

function uploadError(status, code, { reason = null, message = "Unggahan gagal; coba lagi" } = {}) {
  const error = new Error(message);
  error.name = "UploadError";
  error.status = status;
  error.code = code;
  error.reason = reason;
  return error;
}

// Plan §5.9 G5 for the logo, from the plan's text (independent of the gizmo's own geometry).
function unsafeLogo([x, y, w, h], { w: width, h: height }) {
  const half = (value, by) => Math.floor((2 * value + by) / (2 * by));
  const top = half(93 * height, 1280);
  const bottom = half(280 * height, 1280);
  const right = half(93 * width, 720);
  return y < top || y + h > height - bottom || x + w > width - right;
}

/** The fake plan (fakes.fakePlan) plus the logo placement and its G5 warning. */
export function harnessPlan(doc) {
  const plan = fakePlan(doc);
  const index = doc.tracks.findIndex((track) => track.kind === "visual" && track.items.length);
  if (index < 0) return plan;
  const item = doc.tracks[index].items[0];
  const meta = doc.assets[item.payload.asset];
  const box = logoBox({ ...item.transform, asset_w: meta.w, asset_h: meta.h, out_w: doc.output.w, out_h: doc.output.h });
  // `harnessAsset` is the harness's own field (the painting player's image), not part of the DTO.
  plan.logo = { box: { x: box[0], y: box[1], w: box[2], h: box[3] }, opacityPm: item.transform.opacity_pm, state: "ready",
    url: null, harnessAsset: item.payload.asset };
  if (unsafeLogo(box, doc.output)) {
    plan.warnings = [...plan.warnings, { code: "unsafe_zone", path: `/tracks/${index}/items/0/transform`, ref: item.id }];
  }
  return plan;
}

function createHarnessUploads(config, images) {
  const fake = createFakeUploadClient();
  const calls = [];
  const rules = config.upload ?? {};
  async function uploadAsset(jobId, file, kind, { onProgress = () => {}, signal } = {}) {
    calls.push({ jobId, name: file?.name ?? null, size: file?.size ?? null, type: file?.type ?? null, kind });
    const failure = rules.fail?.[file?.name];
    if (failure === "network") {
      await wait(rules.stepMs ?? 20, signal);
      throw uploadError(0, "network_error", { message: "Koneksi terputus saat mengunggah; coba lagi" });
    }
    const steps = rules.steps ?? 4;
    // The fake checks the §9.2 type and size rules first, like T3.1's client does before sending.
    const dto = await fake.uploadAsset(jobId, file, kind, { signal });
    for (let step = 1; step <= steps; step += 1) {
      await wait(rules.stepMs ?? 20, signal);
      onProgress(step / steps, { phase: "upload" });
    }
    onProgress(1, { phase: "processing" });
    await wait(rules.processingMs ?? 40, signal);
    if (failure) throw uploadError(failure.status, failure.code, failure);
    const [w, h] = rules.sizes?.[file.name] ?? [512, 512];
    images.set(`sha256:${dto.sha256}`, file);
    return { ...dto, w, h, name: file.name };
  }
  return { uploadAsset, calls };
}

// A player that paints the stage: a dark gradient and the logo image at its plan box with its
// opacity (dev only; the real player draws the server's derived PNG, plan §6.2).
function createPaintingPlayer(options, images) {
  const player = createFakePlayer(options);
  const canvas = options.canvas;
  let generation = 0;
  async function paint(plan) {
    const context = canvas?.getContext?.("2d");
    if (!context) return;
    const mine = ++generation;
    const logo = plan?.logo;
    const file = logo ? images.get(logo.harnessAsset) : null;
    const bitmap = file ? await createImageBitmap(file).catch(() => null) : null;
    if (mine !== generation) return;
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, HARNESS_FRAME_GRADIENT[0]);
    gradient.addColorStop(1, HARNESS_FRAME_GRADIENT[1]);
    context.globalAlpha = 1;
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (bitmap && logo) {
      context.globalAlpha = logo.opacityPm / 1000;
      context.drawImage(bitmap, logo.box.x, logo.box.y, logo.box.w, logo.box.h);
      context.globalAlpha = 1;
    }
  }
  return {
    ...player,
    load(plan) {
      player.load(plan);
      paint(plan);
    },
  };
}

export function createLogoHarness(config = {}) {
  const images = new Map();
  const uploads = createHarnessUploads(config, images);
  const planCalls = [];
  const api = createFakeApiClient({ doc: config.doc ?? fakeDoc() });
  if (config.readOnly) {
    const getEdit = api.getEdit.bind(api);
    api.getEdit = async (options) => ({ ...(await getEdit(options)), readOnly: true, readOnlyReason: "transcript_changed" });
  }
  const previewClient = {
    async plan(doc) {
      planCalls.push(doc.audit?.last_command ?? null);
      await wait(config.planMs ?? 30);
      return harnessPlan(doc);
    },
    async frame() {
      return new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" });
    },
  };
  const store = createEditorStore({
    jobId: FAKE_JOB_ID, clipId: FAKE_CLIP_ID, api, previewClient,
    draftStore: createDraftStore({ indexedDB: null }), channel: null, lifecycle: null, tabStorage: null,
  });
  // Every dispatch, kept (the store's own pending log empties after each save).
  const log = [];
  const dispatch = store.dispatch;
  store.dispatch = (type, args = {}, options = {}) => {
    const entry = { type, args, mergeKey: options?.mergeKey ?? null, ok: true, code: null };
    log.push(entry);
    try {
      return dispatch(type, args, options);
    } catch (error) {
      entry.ok = false;
      entry.code = error?.code ?? null;
      throw error;
    }
  };
  const unregister = provideLogoUploader(uploads.uploadAsset);
  let counter = 0;
  const runtime = {
    kind: "fake",
    api,
    previewClient,
    store,
    createPlayer: (options) => createPaintingPlayer(options, images),
    setPlayhead() {},
    pollMs: 1000,
    newKey: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    destroy() {
      unregister();
      store.destroy();
    },
  };
  return { runtime, store, api, log, uploads: uploads.calls, planCalls, ready: false };
}
