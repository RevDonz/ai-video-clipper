// The export dialog's state machine (plan Appendix C.5; §4.2 `POST …/renders`, `GET` and
// `DELETE /renders/:id`; §4.6 request states). DOM-free: timers, keys and the clock are injected,
// so the flow is unit-tested with a manual clock (web/tests/editor-export-flow.test.mjs).
//
// Phases: idle → saving (autosave flushed first) → submitting (createRender) → running (polled)
// → completed | failed | cancelled; any client-side failure is `error` with a code. A retry after
// a network failure while enqueuing reuses the same Idempotency-Key; any other retry is a new
// request with a new key.
import { messageFor } from "./shell-model.mjs";

export const EXPORT_STEPS = Object.freeze([
  Object.freeze({ id: "antre", label: "Antre" }),
  Object.freeze({ id: "merender", label: "Merender" }),
  Object.freeze({ id: "memverifikasi", label: "Memverifikasi" }),
  Object.freeze({ id: "selesai", label: "Selesai" }),
]);

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const MAX_POLL_FAILURES = 5;

const CLIENT_TEXT = {
  save_failed: "Perubahan belum tersimpan, jadi ekspor belum dimulai. Simpan dulu, lalu coba lagi.",
  network: "Koneksi ke server terputus. Periksa jaringan, lalu coba lagi.",
  invalid_response: "Server memberi jawaban yang tidak dikenali.",
};

export function exportErrorText(code) {
  return CLIENT_TEXT[code] ?? messageFor(code);
}

function stepOf(render) {
  if (!render) return -1;
  if (render.state === "completed") return 4;
  const byStage = EXPORT_STEPS.findIndex((step) => step.id === render.stage);
  if (byStage >= 0) return byStage;
  if (render.state === "rendering") return 1;
  return 0;
}

const STOPPED = new Set(["cancelled", "failed"]);

/**
 * Steps with done/current/todo and the current step's text ("Merender (45%)"). A cancelled or
 * failed render keeps the step it had reached (`lastRunning`, the flow's last running render;
 * the server's terminal request no longer says) with the status "stopped" (W2 verifier).
 */
export function exportStepView(render, lastRunning = null) {
  const stopped = STOPPED.has(render?.state);
  const shown = stopped ? (lastRunning?.renderId === render.renderId ? lastRunning : { ...render, state: "queued", stage: "antre" }) : render;
  const index = stepOf(shown);
  const steps = EXPORT_STEPS.map((step, position) => ({
    ...step,
    status: position < index ? "done" : position === index ? (stopped ? "stopped" : "current") : "todo",
    text: step.id === "merender" && position === index
      ? `Merender (${Math.max(0, Math.min(99, Math.floor((shown?.progressPm ?? 0) / 10)))}%)`
      : step.label,
  }));
  const current = steps.find((step) => step.status === "current" || step.status === "stopped");
  return { steps, text: index < 0 ? "" : current ? current.text : EXPORT_STEPS.at(-1).label };
}

/**
 * "Ekspor sebelumnya": this session's exports and the clip's latest one (Open 16), without the
 * export the dialog is running (it has its own progress row; W2 verifier). A finished one stays.
 */
export function earlierExports({ history = [], current = null, latest = null } = {}) {
  const running = current?.renderId && !TERMINAL.has(current.state) ? current.renderId : null;
  const items = history.filter((item) => item.renderId !== running);
  if (latest?.renderId && latest.renderId !== running && !items.some((item) => item.renderId === latest.renderId)) {
    items.push({ renderId: latest.renderId, revision: latest.revision, atMs: null, state: latest.state,
      resultUrl: latest.url ?? null, srtUrl: latest.srtUrl ?? null });
  }
  return items;
}

/** Export may start only when every warning is acknowledged and nothing blocks it. */
export function canStartExport(checks, acknowledged) {
  if (checks.some((check) => check.severity === "error")) return false;
  // A note (severity "info": the caption at the auto clip's spot, K5) informs; it needs no tick.
  return checks.every((check) => check.severity === "info" || acknowledged.has(check.key));
}

function errorCodeOf(error) {
  if (error && typeof error === "object" && Number.isInteger(error.status)) return typeof error.code === "string" ? error.code : "internal_error";
  return "network";
}

function validRender(value) {
  return Boolean(value && typeof value === "object" && typeof value.renderId === "string" && typeof value.state === "string");
}

export function createExportFlow({
  api, store, newKey, pollMs = 1000, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
  onChange = () => {},
}) {
  let state = { phase: "idle", render: null, lastRunning: null, errorCode: null, errorText: null, key: null, cancelling: false, history: [] };
  let timer = null;
  let destroyed = false;
  let generation = 0;
  let pollFailures = 0;
  let reuseKey = false;

  const set = (patch) => {
    if (destroyed) return;
    state = { ...state, ...patch };
    onChange(state);
  };

  const stopTimer = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const remember = (render) => {
    const entry = { renderId: render.renderId, revision: render.revision ?? null, state: render.state,
      atMs: state.history.find((item) => item.renderId === render.renderId)?.atMs ?? now(),
      resultUrl: render.resultUrl ?? null, srtUrl: render.srtUrl ?? null };
    const history = [entry, ...state.history.filter((item) => item.renderId !== render.renderId)];
    return history;
  };

  const schedule = (id) => {
    stopTimer();
    timer = setTimer(() => { timer = null; poll(id); }, pollMs);
  };

  const apply = (render, id) => {
    if (id !== generation || destroyed) return;
    if (!validRender(render)) {
      set({ phase: "error", errorCode: "invalid_response", errorText: exportErrorText("invalid_response"), cancelling: false });
      return;
    }
    const history = remember(render);
    if (render.state === "completed") {
      stopTimer();
      set({ phase: "completed", render, history, cancelling: false, errorCode: null, errorText: null });
    } else if (render.state === "cancelled") {
      stopTimer();
      set({ phase: "cancelled", render, history, cancelling: false, errorCode: "cancelled", errorText: messageFor("cancelled") });
    } else if (render.state === "failed") {
      stopTimer();
      const code = render.errorCode || "render_failed";
      set({ phase: "failed", render, history, cancelling: false, errorCode: code, errorText: messageFor(code) });
    } else {
      set({ phase: "running", render, lastRunning: render, history });
      schedule(id);
    }
  };

  async function poll(id) {
    if (id !== generation || destroyed || !state.render) return;
    try {
      const render = await api.getRender(state.render.renderId);
      pollFailures = 0;
      apply(render, id);
    } catch (error) {
      if (id !== generation || destroyed) return;
      pollFailures += 1;
      if (pollFailures >= MAX_POLL_FAILURES) {
        stopTimer();
        set({ phase: "error", errorCode: errorCodeOf(error), errorText: exportErrorText(errorCodeOf(error)), cancelling: false });
      } else {
        schedule(id);
      }
    }
  }

  async function sendCancel(id) {
    try {
      const render = await api.cancelRender(state.render.renderId);
      apply(render, id);
    } catch (error) {
      if (id !== generation) return;
      set({ cancelling: false, errorCode: errorCodeOf(error), errorText: exportErrorText(errorCodeOf(error)) });
      if (state.phase === "running") schedule(id);
    }
  }

  async function start() {
    if (destroyed || ["saving", "submitting", "running"].includes(state.phase)) return;
    generation += 1;
    const id = generation;
    pollFailures = 0;
    stopTimer();
    const key = reuseKey && state.key ? state.key : newKey();
    reuseKey = false;
    set({ phase: "saving", render: null, lastRunning: null, errorCode: null, errorText: null, key, cancelling: false });
    try {
      await store.flush();
    } catch {
      // The store reports its own failure through `save`; checked below.
    }
    if (id !== generation || destroyed) return;
    const saved = store.getState();
    if (state.cancelling) {
      set({ phase: "cancelled", cancelling: false, errorCode: "cancelled", errorText: messageFor("cancelled") });
      return;
    }
    if (!saved || saved.save === "error" || saved.save === "conflict" || saved.save === "dirty"
      || typeof saved.etag !== "string" || !saved.etag) {
      set({ phase: "error", errorCode: "save_failed", errorText: exportErrorText("save_failed") });
      return;
    }
    set({ phase: "submitting" });
    let render;
    try {
      render = await api.createRender({ editEtag: saved.etag }, key);
    } catch (error) {
      if (id !== generation || destroyed) return;
      const code = errorCodeOf(error);
      reuseKey = code === "network";
      set({ phase: "error", errorCode: code, errorText: exportErrorText(code), cancelling: false });
      return;
    }
    if (id !== generation || destroyed) return;
    const cancelRequested = state.cancelling;
    apply(render, id);
    if (cancelRequested && state.phase === "running") await sendCancel(id);
  }

  async function cancel() {
    if (destroyed) return;
    if (state.phase === "saving" || state.phase === "submitting") {
      set({ cancelling: true });
      return;
    }
    if (state.phase !== "running" || !state.render) return;
    set({ cancelling: true });
    await sendCancel(generation);
  }

  return {
    getState: () => state,
    start,
    retry: start,
    cancel,
    isTerminal: () => TERMINAL.has(state.render?.state),
    /** Back to idle after a finished export (a new export of later edits); keeps the history. */
    reset() {
      if (destroyed || ["saving", "submitting", "running"].includes(state.phase)) return;
      stopTimer();
      generation += 1;
      reuseKey = false;
      set({ phase: "idle", render: null, lastRunning: null, errorCode: null, errorText: null, key: null, cancelling: false });
    },
    destroy() {
      destroyed = true;
      stopTimer();
    },
  };
}
