// Hook suggestions in the Teks panel (plan §7.1, T3.4): the request, the polling of the LLM task,
// the labels and the command a card applies. Plain JS so node tests can drive it; the React part
// is suggestions/index.jsx.
//
// One controller per clip and API client lives for the page: switching panels keeps the cards and
// a running task. A new request is made on first open and when the user asks for it
// ("Perbarui saran"); every request is one POST (the server counts LLM tasks per job and hour).

export const SOURCE_LABELS = Object.freeze({ ai_selection: "AI seleksi", heuristic: "Heuristik", llm: "AI" });
export const SOURCE_HINTS = Object.freeze({
  ai_selection: "Ditulis AI saat klip ini dipilih",
  heuristic: "Disusun dari kalimat di transkrip, tanpa AI",
  llm: "Ditulis AI dari transkrip klip yang sudah diedit",
});
export const POLL_MS = 1000;
export const POLL_LIMIT_MS = 30_000;
export const TASK_SECONDS = 20;

export const COPY = Object.freeze({
  title: "Saran hook",
  loading: "Mencari saran hook…",
  error: "Saran hook belum bisa dimuat.",
  retry: "Coba lagi",
  empty: "Belum ada saran untuk klip ini. Tulis hook sendiri di kolom di atas.",
  refresh: "Perbarui saran",
  stale: "Klip sudah diubah sejak saran ini dibuat.",
  pending: "AI sedang menulis saran dari transkrip klip ini…",
  failed: "Saran AI belum tersedia (kuota/koneksi); memakai saran otomatis.",
  none: "AI belum menemukan hook yang sesuai isi klip ini. Pakai saran otomatis atau tulis sendiri.",
  privacy: "Teks transkrip klip ini dikirim ke penyedia AI yang aktif di Pengaturan. Layanan gratis bisa memakai data yang dikirim.",
  use: "Pakai",
  used: "Dipakai",
  fits: "Muat",
  overflow: "Akan terpotong",
  basis: "Dari transkrip:",
  readOnly: "Klip ini hanya bisa dibaca",
});

export function rateLimitedText(retryAfterMs) {
  const minutes = Math.max(1, Math.ceil((Number(retryAfterMs) || 60_000) / 60_000));
  return `Batas saran AI untuk proyek ini sudah tercapai (30 per jam). Coba lagi dalam ${minutes} menit.`;
}

export function hookItem(doc) {
  return doc?.tracks?.find((track) => track.kind === "hook")?.items?.[0] ?? null;
}

function normal(text) {
  return typeof text === "string" ? text.normalize("NFC").replace(/\s+/g, " ").trim() : "";
}

export function sameText(first, second) {
  return normal(first) !== "" && normal(first) === normal(second);
}

/** The transcript content suggestions depend on (cuts and word fixes), not the hook text itself. */
export function contentKey(doc) {
  if (!doc) return null;
  return JSON.stringify([doc.main?.segments ?? [], doc.main?.removals ?? [], doc.captions?.word_edits ?? {}]);
}

/** The one undoable command a card applies (Appendix B), with the suggestion as its origin. */
export function applyCommand(doc, suggestion) {
  const origin = `suggestion:${suggestion.id}`;
  if (hookItem(doc)) return { type: "SetHookText", args: { text: suggestion.text, origin } };
  return { type: "SetHookEnabled", args: { on: true, text: suggestion.text, origin } };
}

const LLM_OFF = Object.freeze({ state: "off", taskId: null, suggestions: [], message: null, retryAfterMs: null, code: null, startedAt: null });

function llmFromAnswer(answer, startedAt) {
  const llm = answer?.llm ?? {};
  if (llm.state === "pending" && typeof answer.taskId === "string") return { ...LLM_OFF, state: "pending", taskId: answer.taskId, startedAt };
  if (llm.state === "rate_limited") return { ...LLM_OFF, state: "rate_limited", retryAfterMs: Number.isFinite(llm.retryAfterMs) ? llm.retryAfterMs : null };
  if (llm.state === "disabled" && typeof llm.message === "string" && llm.message) return { ...LLM_OFF, state: "notice", message: llm.message };
  return LLM_OFF;
}

const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item.text === "string" && typeof item.id === "string") : []);

export function createSuggestions({ api, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id), pollMs = POLL_MS, pollLimitMs = POLL_LIMIT_MS } = {}) {
  const listeners = new Set();
  let state = { phase: "idle", heuristic: [], key: null, error: null, llm: LLM_OFF };
  let sequence = 0;
  let timer = null;
  let destroyed = false;

  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state);
  };
  const stopPolling = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const failLlm = (code) => set({ llm: { ...state.llm, state: "failed", code } });

  const schedule = (seq) => {
    stopPolling();
    timer = setTimer(() => { timer = null; poll(seq); }, pollMs);
  };

  async function poll(seq) {
    if (destroyed || seq !== sequence || state.llm.state !== "pending") return;
    const overdue = () => now() - state.llm.startedAt > pollLimitMs;
    try {
      const answer = await api.aiTask(state.llm.taskId);
      if (destroyed || seq !== sequence) return;
      if (answer?.state === "done") {
        set({ llm: { ...state.llm, state: "done", suggestions: list(answer.suggestions) } });
      } else if (answer?.state === "failed") {
        failLlm(typeof answer.error?.code === "string" ? answer.error.code : "internal_error");
      } else if (overdue()) {
        failLlm("timeout");
      } else {
        schedule(seq);
      }
    } catch (error) {
      if (destroyed || seq !== sequence) return;
      if (error?.status === 404 || overdue()) failLlm(error?.status === 404 ? "not_found" : "timeout");
      else schedule(seq);
    }
  }

  async function request(doc) {
    if (destroyed || !doc) return;
    const seq = ++sequence;
    stopPolling();
    set({ phase: "loading", error: null, key: contentKey(doc) });
    try {
      const answer = await api.aiHooks(doc);
      if (destroyed || seq !== sequence) return;
      const llm = llmFromAnswer(answer, now());
      set({ phase: "ready", heuristic: list(answer?.heuristic), llm });
      if (llm.state === "pending") schedule(seq);
    } catch (error) {
      if (destroyed || seq !== sequence) return;
      set({ phase: "error", error: { code: typeof error?.code === "string" ? error.code : "network_error" } });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The first request for this clip (later calls do nothing until `request`). */
    ensure(doc) {
      if (state.phase === "idle") request(doc);
    },
    request,
    destroy() {
      destroyed = true;
      stopPolling();
      listeners.clear();
    },
  };
}

const CONTROLLERS = new WeakMap();

/** The page-lifetime controller of one clip for one API client. */
export function suggestionsFor(api, clipId, factory = createSuggestions) {
  if (!api || typeof clipId !== "string") return null;
  let byClip = CONTROLLERS.get(api);
  if (!byClip) {
    byClip = new Map();
    CONTROLLERS.set(api, byClip);
  }
  if (!byClip.has(clipId)) byClip.set(clipId, factory({ api }));
  return byClip.get(clipId);
}

/** What the AI part of the section shows: hidden when the LLM is off without a notice. */
export function aiView(llm) {
  switch (llm?.state) {
    case "pending": return { visible: true, status: "pending", text: COPY.pending };
    case "failed": return { visible: true, status: "failed", text: COPY.failed };
    case "rate_limited": return { visible: true, status: "rate_limited", text: rateLimitedText(llm.retryAfterMs) };
    case "notice": return { visible: true, status: "notice", text: llm.message };
    case "done": return { visible: true, status: llm.suggestions.length ? "done" : "none", text: llm.suggestions.length ? null : COPY.none };
    default: return { visible: false, status: "off", text: null };
  }
}
