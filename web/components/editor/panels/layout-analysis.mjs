// The face analysis of one clip, outside any component (docs/plans/2026-10-02-editor-mode-cepat.md
// §4.1, AC16). Mode Cepat's Tata letak card and Mode Lengkap's LayoutPanel both start it and both
// read it, so closing the card, switching the panel or switching the view never drops a run, and
// either view shows the progress of a run the other started.
//
// A run is `prepare {layout: "camera"}` (plan §5.7; instant when the camera plan exists), with the
// server's progress polled when the API has `cameraProgress`. When it ends:
// - it applies `SetLayout {mode: "camera"}` through the dispatch it was started with, if it was
//   started to switch (`switchAfter`) and no newer choice or run has superseded it;
// - a failure keeps the layout and sets `phase: "failed"` with its code and message;
// - success marks the clip's camera plan as known (`cameraReady`), so face-track needs no second run.
//
// State: `{ phase, startedAt, done, total, target, message, code, range, cameraReady }`, where
// `phase` is "idle", "starting" (the first 250 ms, so an existing plan does not flicker), "running"
// or "failed", and `target` is "camera" while the run will switch.
import { rejectionText } from "../shell-model.mjs";
import { analysisRangeMs, analysisView, layoutCommand } from "./layout-model.mjs";

export const SHOW_ANALYSIS_AFTER_MS = 250;
export const PROGRESS_POLL_MS = 500;

export const IDLE_ANALYSIS = Object.freeze({
  phase: "idle", startedAt: null, done: null, total: null, target: null, message: null, code: null, range: null, cameraReady: false,
});

const BUSY = new Set(["starting", "running"]);

/** True while a run is on (shown or not yet). */
export function analysisBusy(state) {
  return BUSY.has(state?.phase);
}

/**
 * The run as layout-model's `analysisView` reads it: `{state: "running", startedAt, done, total,
 * range}` once shown, `{state: "failed", code}` after a failure, else null.
 */
export function analysisForView(state) {
  if (state?.phase === "running") {
    return { state: "running", startedAt: state.startedAt, done: state.done, total: state.total, range: state.range };
  }
  if (state?.phase === "failed") return { state: "failed", code: state.code };
  return null;
}

function failure(code, now) {
  return analysisView({ state: "failed", code }, now).text;
}

export function createLayoutAnalysis({
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  showAfterMs = SHOW_ANALYSIS_AFTER_MS,
  pollMs = PROGRESS_POLL_MS,
} = {}) {
  const listeners = new Set();
  let state = IDLE_ANALYSIS;
  let token = 0;
  let autoTried = false;

  const set = (patch) => {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener(state);
  };

  async function start({ api, dispatch, getState, switchAfter = true, auto = false } = {}) {
    if (auto) {
      if (autoTried) return false;
      autoTried = true;
    }
    if (switchAfter && analysisBusy(state) && state.target === "camera") return false; // already on its way
    const run = ++token;
    const target = switchAfter ? "camera" : null;
    set({ phase: "starting", startedAt: now(), done: null, total: null, target, message: null, code: null,
      range: analysisRangeMs(getState?.()?.doc) });

    const timers = [];
    timers.push(setTimer(() => {
      if (run !== token || state.phase !== "starting" || (switchAfter && state.target !== "camera")) return;
      set({ phase: "running" });
    }, showAfterMs));
    if (typeof api?.cameraProgress === "function") {
      const tick = async () => {
        try {
          const progress = await api.cameraProgress();
          if (run === token && progress?.state === "building" && Number.isSafeInteger(progress.total)) {
            set({ done: progress.done, total: progress.total });
          }
        } catch {
          // progress is advice: the analysis itself decides
        }
        if (run === token) timers.push(setTimer(tick, pollMs));
      };
      timers.push(setTimer(tick, showAfterMs));
    }

    let outcome;
    try {
      if (!api || typeof api.prepare !== "function") throw Object.assign(new Error("no api"), { code: "backend_unavailable" });
      const result = await api.prepare({ layout: "camera" });
      if (result && result.camera !== undefined && result.camera !== "ready") {
        throw Object.assign(new Error("camera not ready"), { code: "analysis_missing" });
      }
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, code: typeof error?.code === "string" ? error.code : "internal_error" };
    }

    if (run !== token) {
      // A newer run took over; this one still tells whether the clip's camera plan exists.
      for (const id of timers) clearTimer(id);
      if (outcome.ok) set({ cameraReady: true });
      return false;
    }
    token += 1; // ends this run's progress poll
    for (const id of timers) clearTimer(id);
    const wanted = state.target;
    if (!outcome.ok) {
      if (wanted === "camera" || !switchAfter) {
        set({ ...IDLE_ANALYSIS, cameraReady: state.cameraReady, phase: "failed", code: outcome.code, message: failure(outcome.code, now()) });
      } else {
        set({ ...IDLE_ANALYSIS, cameraReady: state.cameraReady });
      }
      return false;
    }
    set({ ...IDLE_ANALYSIS, cameraReady: true });
    if (wanted !== "camera" || getState?.()?.doc?.layout?.default?.mode === "camera") return true;
    const { type, args, mergeKey } = layoutCommand("camera");
    try {
      dispatch(type, args, { mergeKey });
    } catch (error) {
      set({ message: rejectionText(error) });
      return false;
    }
    return true;
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    /**
     * Another layout was chosen: the pending switch is dropped and the progress hidden; the run
     * finishes on the server and still marks the camera plan as known.
     */
    cancelSwitch() {
      if (state.target === null && !analysisBusy(state) && state.phase !== "failed") return;
      set({ phase: "idle", target: null, done: null, total: null, code: null, message: null });
    },
    clearMessage() {
      if (state.message !== null && state.phase !== "failed") set({ message: null });
    },
  };
}

const STORES = new Map();

/** The page-lifetime analysis of one clip (null without a clip id). */
export function layoutAnalysisFor(clipId, factory = createLayoutAnalysis) {
  if (typeof clipId !== "string" || !clipId) return null;
  if (!STORES.has(clipId)) STORES.set(clipId, factory());
  return STORES.get(clipId);
}

/**
 * The API the analysis runs on: the shell's, else the fake runtime's (its dev hook, as the panels
 * find it), else null; LayoutPanel adds its own client for the app when the shell passes none.
 */
export function analysisApi(api, global = globalThis) {
  if (api && typeof api.prepare === "function") return api;
  const fake = global?.window?.__potonginEditor?.api ?? global?.__potonginEditor?.api;
  return fake && typeof fake.prepare === "function" ? fake : null;
}
