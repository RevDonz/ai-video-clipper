// Store and player for the T3.7 e2e harness (web/e2e/editor-markers.spec.mjs). Dev and test only.
//
// The store applies the real Appendix B commands (web/lib/editor/commands.mjs) to the document,
// logs every dispatch and recomputes a minimal plan DTO (pieces from the real time map) 100 ms
// after a change, as the debounced preview does. The player advances frames in real time and
// logs seek/play/pause, so auditions and click-to-seek can be checked.
import { applyCommand } from "../../../../../lib/editor/commands.mjs";
import { createContext } from "../../../../../lib/editor/doc-model.mjs";
import { pieces as docPieces, totalFrames } from "../../../../../lib/editor/timemap.mjs";

export function harnessPlan(doc) {
  const pieces = docPieces(doc);
  const total = totalFrames(pieces);
  const hookItem = doc.tracks.find((track) => track.kind === "hook")?.items?.[0] ?? null;
  return {
    planSha256: "0".repeat(64), fps: doc.output.fps, totalFrames: total, output: { w: doc.output.w, h: doc.output.h },
    pieces, cues: [],
    hook: hookItem ? { f0: 0, f1: Math.min(hookItem.dur_f, total), lines: [hookItem.payload.text], overflow: false } : null,
    plate: { cellFrames: 60, cells: [] }, logo: null, audio: { musicGainPoints: [], speechSpans: [] },
    warnings: [], errors: [],
  };
}

export function createHarnessStore({ words, doc, readOnly = false, planDelayMs = 100 }) {
  const ctx = createContext({ words, seed: doc });
  const listeners = new Set();
  const log = [];
  const past = [];
  let timer = null;
  let state = {
    status: readOnly ? "readOnly" : "ready", jobId: doc.base.job_id, clipId: doc.clip_id, doc, seed: doc, words,
    plan: harnessPlan(doc), save: "saved", pending: [], warnings: [], selection: null, canUndo: false, canRedo: false,
  };
  const set = (patch) => {
    state = { ...state, ...patch, canUndo: past.length > 0 };
    for (const listener of [...listeners]) listener(state);
  };
  const replan = () => {
    clearTimeout(timer);
    timer = setTimeout(() => set({ plan: harnessPlan(state.doc), pending: [] }), planDelayMs);
  };
  return {
    log,
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispatch(type, args = {}, { mergeKey = null } = {}) {
      try {
        if (state.status !== "ready") {
          const error = new Error("read only");
          error.code = "read_only";
          throw error;
        }
        const result = applyCommand(state.doc, type, args, ctx);
        log.push({ type, args, mergeKey, ok: true });
        past.push(state.doc);
        set({ doc: result.doc, save: "dirty", pending: ["text"] });
        replan();
        return result.doc;
      } catch (error) {
        log.push({ type, args, mergeKey, ok: false, code: error?.code ?? null });
        throw error;
      }
    },
    undo() {
      if (!past.length) return;
      set({ doc: past.pop() });
      replan();
    },
    replace(nextDoc) {
      set({ doc: nextDoc, plan: harnessPlan(nextDoc) });
    },
  };
}

export function createHarnessPlayer({ fps, frameBus, now = () => performance.now() }) {
  const log = [];
  let plan = null;
  let playing = false;
  let startedAt = 0;
  let startFrame = 0;
  let timer = null;
  const last = () => Math.max(0, (plan?.totalFrames ?? 1) - 1);
  const clamp = (value) => Math.max(0, Math.min(last(), value));
  const tick = () => {
    if (!playing) return;
    const next = startFrame + Math.floor(((now() - startedAt) * fps[0]) / (1000 * fps[1]));
    frameBus.set(clamp(next));
    if (next >= last()) {
      playing = false;
      clearInterval(timer);
    }
  };
  return {
    log,
    load(dto) { plan = dto; },
    async play() {
      log.push({ op: "play", frame: frameBus.get(), at: now() });
      playing = true;
      startedAt = now();
      startFrame = frameBus.get();
      clearInterval(timer);
      timer = setInterval(tick, 8);
    },
    pause() {
      tick();
      playing = false;
      clearInterval(timer);
      log.push({ op: "pause", frame: frameBus.get(), at: now() });
    },
    async seek(target) {
      log.push({ op: "seek", frame: target, at: now() });
      frameBus.set(clamp(target));
      startedAt = now();
      startFrame = frameBus.get();
    },
    async step(delta) { frameBus.set(clamp(frameBus.get() + delta)); },
    async showTruthFrame() {},
    state() { return { mode: "live", frame: frameBus.get(), playing }; },
    stats() { return null; },
    frame: () => frameBus.get(),
    subscribeFrame: (listener) => frameBus.subscribe(listener),
    destroy() { playing = false; clearInterval(timer); },
  };
}
