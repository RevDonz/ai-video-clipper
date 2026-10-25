// The Pengaturan "Transkripsi" tab, DOM-free: the state from GET /api/settings/transcription and
// the tab's messages as descriptors (rombak 07 §8.3): `{ key, values? }` names a message under the
// "settings" namespace, `{ text }` carries the server's own words for a refused value. The words
// are in web/messages/<locale>/settings.json; web/lib/transcription-settings.mjs is the server side.

export const GROQ_KEY_URL = "https://console.groq.com/keys";

const KEY_SOURCES = new Set(["llm", "own", "missing", "unreadable"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** `{enabled, key, ownKey, llmKey, secretConfigured, updatedAt, problem}` from an answer. */
export function transcriptionState(payload) {
  return {
    enabled: payload?.enabled === true,
    key: KEY_SOURCES.has(payload?.key) ? payload.key : "missing",
    ownKey: payload?.ownKey === true,
    llmKey: payload?.llmKey === true,
    secretConfigured: payload?.secretConfigured === true,
    updatedAt: typeof payload?.updatedAt === "string" && ISO_TIME.test(payload.updatedAt) ? payload.updatedAt : null,
    problem: payload?.problem === "corrupt" ? "corrupt" : null,
  };
}

/** The one warning the tab shows under the switch, `{ tone, key }`, or null. */
export function transcriptionNotice(state) {
  if (state.problem === "corrupt") return { tone: "error", key: "transcription.notice.corrupt" };
  if (!state.secretConfigured) return { tone: "error", key: "transcription.notice.secretMissing" };
  if (state.key === "unreadable") return { tone: "error", key: "transcription.notice.unreadable" };
  if (state.enabled && state.key === "missing") return { tone: "warning", key: "transcription.notice.keyMissing" };
  return null;
}

/** What the next job uses, after a save. */
export function transcriptionSavedMessage(state) {
  if (!state.enabled) return { key: "transcription.saved.whisper" };
  if (state.key === "llm" || state.key === "own") return { key: "transcription.saved.groq" };
  return { key: "transcription.saved.needsKey" };
}

const ERRORS = Object.freeze({
  secret_missing: "common.error.secretMissing",
  settings_unavailable: "common.error.settingsUnavailable",
  csrf_rejected: "common.error.csrf",
});

/** The message of a refused change: `{status, code, error}` from the answer (status 0: offline). */
export function transcriptionErrorMessage({ status, code, error } = {}) {
  if (status === 401) return { key: "common.error.session" };
  if (status === 0) return { key: "common.error.offline" };
  if (code === "invalid" && typeof error === "string" && error) return { text: error };
  return { key: Object.hasOwn(ERRORS, code) ? ERRORS[code] : "transcription.error.failed" };
}

/** Every key this module can name, for the catalog test and the tab's lookup. */
export const TRANSCRIPTION_VIEW_KEYS = Object.freeze([
  "transcription.notice.corrupt",
  "transcription.notice.secretMissing",
  "transcription.notice.unreadable",
  "transcription.notice.keyMissing",
  "transcription.saved.whisper",
  "transcription.saved.groq",
  "transcription.saved.needsKey",
  "transcription.error.failed",
  "common.error.session",
  "common.error.offline",
  ...Object.values(ERRORS),
]);
