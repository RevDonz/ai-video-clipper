// Cek ejaan (spelling review): the request, the polling of the LLM task, the rows the review lists
// against the current document and the commands an accepted suggestion dispatches. Plain JS so
// node tests can drive it; the React part is use-spell-check.js and SpellingReview.jsx.
//
// One controller per clip and API client lives for the page, so switching views or closing the
// review keeps the answer. A check is asked only when the viewer opens the review or presses
// "Periksa lagi" (each is one POST; the server counts LLM tasks per job and hour).
//
// A suggestion names its words, their text when it was made (`from`) and the first word's new
// text (`to`); further words are merged into it and hidden from the caption. It is open while
// those words still read `from` and show in the clip, applied once they read `to`, else stale.
import { checkCommands } from "../../../lib/editor/caption-lines.mjs";

export const POLL_MS = 1000;
export const POLL_LIMIT_MS = 30_000;
export const CONTEXT_WORDS = 3;
export const KIND_LABELS = Object.freeze({ case: "Huruf kapital", spacing: "Spasi", spelling: "Ejaan" });

export const COPY = Object.freeze({
  toggle: "Cek ejaan",
  toggleTitle: "Salah ketik, spasi antarkata dan penulisan nama, diperiksa AI",
  title: "Cek ejaan",
  intro: "AI memeriksa salah ketik, spasi antarkata dan penulisan nama. Arti kalimat tidak diubah.",
  privacy: "Teks transkrip klip ini dikirim ke penyedia AI yang aktif di Pengaturan. Layanan gratis bisa memakai data yang dikirim.",
  checking: "AI sedang memeriksa ejaan…",
  none: "Tidak ada salah ejaan di klip ini.",
  finished: "Semua saran sudah ditangani.",
  failed: "Cek ejaan belum bisa dipakai (kuota/koneksi AI).",
  error: "Cek ejaan belum bisa dimulai.",
  off: "Cek ejaan butuh AI yang aktif. Atur penyedianya di Pengaturan.",
  truncated: "Klip ini panjang: hanya bagian awalnya yang diperiksa.",
  retry: "Coba lagi",
  again: "Periksa lagi",
  accept: "Terima",
  skip: "Lewati",
  play: "Putar",
  stop: "Hentikan",
  unskip: "Tampilkan lagi",
  missing: "Bagian ini tidak ada di klip sekarang.",
  acceptAll: (count) => `Terima semua (${count})`,
  accepted: (count, note = "") => `${count} perbaikan diterapkan${note}. Urungkan dengan Ctrl+Z.`,
  skipped: (count) => `${count} dilewati`,
  stale: (count) => `${count} saran tidak berlaku lagi karena katanya sudah diubah.`,
});

const IDLE = Object.freeze({ phase: "idle", suggestions: [], truncated: false, code: null, message: null, retryAfterMs: null, skipped: [] });

function normal(text) {
  return typeof text === "string" ? text.normalize("NFC").replace(/\s+/g, " ").trim() : "";
}

const isSuggestion = (item) => item !== null && typeof item === "object" && typeof item.id === "string"
  && Array.isArray(item.wordIds) && item.wordIds.length > 0 && item.wordIds.every((id) => typeof id === "string")
  && typeof item.from === "string" && typeof item.to === "string" && Object.hasOwn(KIND_LABELS, item.kind);

export function createSpellCheck({ api, now = () => Date.now(), setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id), pollMs = POLL_MS, pollLimitMs = POLL_LIMIT_MS } = {}) {
  const listeners = new Set();
  let state = IDLE;
  let sequence = 0;
  let timer = null;
  let taskId = null;
  let startedAt = 0;
  let destroyed = false;

  const set = (patch) => {
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state);
  };
  const stopPolling = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const fail = (code) => set({ phase: "failed", code });
  const schedule = (seq) => {
    stopPolling();
    timer = setTimer(() => { timer = null; poll(seq); }, pollMs);
  };

  async function poll(seq) {
    if (destroyed || seq !== sequence || state.phase !== "checking") return;
    const overdue = () => now() - startedAt > pollLimitMs;
    try {
      const answer = await api.aiTask(taskId);
      if (destroyed || seq !== sequence) return;
      if (answer?.state === "done") {
        const suggestions = Array.isArray(answer.suggestions) ? answer.suggestions.filter(isSuggestion) : [];
        set({ phase: "done", suggestions, truncated: answer.truncated === true });
      } else if (answer?.state === "failed") {
        fail(typeof answer.error?.code === "string" ? answer.error.code : "internal_error");
      } else if (overdue()) {
        fail("timeout");
      } else {
        schedule(seq);
      }
    } catch (error) {
      if (destroyed || seq !== sequence) return;
      if (error?.status === 404 || overdue()) fail(error?.status === 404 ? "not_found" : "timeout");
      else schedule(seq);
    }
  }

  async function check(doc) {
    if (destroyed || !doc) return;
    const seq = ++sequence;
    stopPolling();
    set({ ...IDLE, phase: "checking" });
    try {
      const answer = await api.aiSpelling(doc);
      if (destroyed || seq !== sequence) return;
      const llm = answer?.llm ?? {};
      if (llm.state === "pending" && typeof answer.taskId === "string") {
        taskId = answer.taskId;
        startedAt = now();
        schedule(seq);
      } else if (llm.state === "rate_limited") {
        set({ phase: "rate_limited", retryAfterMs: Number.isFinite(llm.retryAfterMs) ? llm.retryAfterMs : null });
      } else if (llm.state === "disabled") {
        set({ phase: "off", message: typeof llm.message === "string" && llm.message ? llm.message : null });
      } else {
        fail("internal_error");
      }
    } catch (error) {
      if (destroyed || seq !== sequence) return;
      set({ phase: "error", code: typeof error?.code === "string" ? error.code : "network_error" });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** The first check for this clip (later calls do nothing until `check`). */
    ensure(doc) {
      if (state.phase === "idle") check(doc);
    },
    check,
    skip(id) {
      if (!state.skipped.includes(id)) set({ skipped: [...state.skipped, id] });
    },
    restoreSkipped() {
      if (state.skipped.length) set({ skipped: [] });
    },
    destroy() {
      destroyed = true;
      stopPolling();
      listeners.clear();
    },
  };
}

const CONTROLLERS = new WeakMap();

/** The page-lifetime controller of one clip for one API client. */
export function spellingFor(api, clipId, factory = createSpellCheck) {
  if (!api || typeof clipId !== "string") return null;
  let byClip = CONTROLLERS.get(api);
  if (!byClip) {
    byClip = new Map();
    CONTROLLERS.set(api, byClip);
  }
  if (!byClip.has(clipId)) byClip.set(clipId, factory({ api }));
  return byClip.get(clipId);
}

// --- rows --------------------------------------------------------------------------------------

const INDEX = new WeakMap();

function indexOf(words) {
  if (!INDEX.has(words)) INDEX.set(words, new Map(words.words.map((word, index) => [word.id, index])));
  return INDEX.get(words);
}

/** A word the edited clip shows: in the body or the cold open, not hidden from the caption. */
const shown = (state) => !state.hidden && ((state.zone === "body" && state.removal === null) || state.cold);

function context(model, from, step) {
  const list = model.words.words;
  const unit = list[from].u;
  const out = [];
  for (let index = from + step; index >= 0 && index < list.length && out.length < CONTEXT_WORDS; index += step) {
    if (list[index].u !== unit) break;
    if (shown(model.states[index])) out.push(model.states[index].text);
  }
  return step < 0 ? out.reverse() : out;
}

/**
 * The review against the document the transcript model was built from: `{rows, applied, stale,
 * skipped}`. `rows` are the open suggestions not skipped, in the answer's (transcript) order, with
 * up to three words of context on each side, the label of their kind and the source span
 * (`s`, `e` in ms) "Putar" plays.
 */
export function spellingRows({ suggestions = [], model, skipped = [] }) {
  const byId = indexOf(model.words);
  const rows = [];
  let applied = 0;
  let stale = 0;
  let skippedCount = 0;
  for (const suggestion of suggestions) {
    const indices = suggestion.wordIds.map((id) => byId.get(id));
    if (indices.some((index) => index === undefined)) {
      stale += 1;
      continue;
    }
    const states = indices.map((index) => model.states[index]);
    if (shown(states[0]) && normal(states[0].text) === normal(suggestion.to) && states.slice(1).every((state) => state.hidden)) {
      applied += 1;
      continue;
    }
    if (!states.every(shown) || normal(states.map((state) => state.text).join(" ")) !== normal(suggestion.from)) {
      stale += 1;
      continue;
    }
    if (skipped.includes(suggestion.id)) {
      skippedCount += 1;
      continue;
    }
    const list = model.words.words;
    rows.push({
      id: suggestion.id, wordIds: suggestion.wordIds, from: suggestion.from, to: suggestion.to, kind: suggestion.kind,
      kindLabel: KIND_LABELS[suggestion.kind], before: context(model, indices[0], -1), after: context(model, indices.at(-1), 1),
      s: list[indices[0]].s, e: list[indices.at(-1)].e,
    });
  }
  return { rows, applied, stale, skipped: skippedCount };
}

// --- commands -----------------------------------------------------------------------------------

/** The commands one accepted row dispatches, all under `mergeKey` (one Urungkan). */
export function acceptCommands(row, mergeKey = null) {
  return [
    { type: "EditWordText", args: { wordId: row.wordIds[0], text: row.to }, mergeKey },
    ...row.wordIds.slice(1).map((wordId) => ({ type: "SetWordHidden", args: { wordId, on: true }, mergeKey })),
  ];
}

/**
 * Dry run of accepting `rows` in order on `doc`: a row the document refuses (a word text over the
 * limit, too many word edits) is skipped with its message and the others still apply.
 * → `{commands, accepted, skipped: [{row, message}]}`.
 */
export function planAccept({ rows, doc, ctx, mergeKey = null }) {
  const commands = [];
  const skipped = [];
  let current = doc;
  for (const row of rows) {
    const mine = acceptCommands(row, mergeKey);
    const result = checkCommands(current, ctx, mine);
    if (!result.ok) {
      skipped.push({ row, message: result.message });
      continue;
    }
    current = result.doc;
    commands.push(...mine);
  }
  return { commands, accepted: rows.length - skipped.length, skipped };
}
