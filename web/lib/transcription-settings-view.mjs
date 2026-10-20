// The Pengaturan "Transkripsi" card, DOM-free: the state from GET /api/settings/transcription, the
// card's copy and its messages (web/lib/transcription-settings.mjs is the server side).

export const GROQ_KEY_URL = "https://console.groq.com/keys";

const KEY_SOURCES = new Set(["llm", "own", "missing", "unreadable"]);
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SESSION_TEXT = "Sesi login berakhir. Muat ulang halaman untuk masuk lagi.";

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

export function transcriptionCopy() {
  return {
    where: "Untuk video tanpa subtitle YouTube yang layak. Bawaannya Whisper di server ini.",
    toggle: "Transkrip lewat Groq",
    privacy: "Audio video dikirim ke Groq, layanan pihak ketiga. Kalau gagal atau kuota gratisnya habis, Whisper di server ini yang dipakai.",
    llmKey: "Memakai API key Groq dari Pengaturan AI.",
    keyLabel: "API key Groq",
    keySaved: "API key tersimpan",
    keyHelp: "Disimpan terenkripsi dan tidak ditampilkan lagi.",
  };
}

/** The one warning the card shows under the switch, or null. */
export function transcriptionNotice(state) {
  if (state.problem === "corrupt") return { tone: "error", text: "File pengaturan transkripsi rusak. Simpan ulang untuk menimpanya." };
  if (!state.secretConfigured) return { tone: "error", text: "Kunci enkripsi pengaturan belum tersedia di server, jadi API key belum bisa disimpan." };
  if (state.key === "unreadable") return { tone: "error", text: "API key Groq tersimpan tidak bisa dibuka. Isi ulang." };
  if (state.enabled && state.key === "missing") return { tone: "warning", text: "Isi API key Groq. Tanpa key, Whisper di server ini yang dipakai." };
  return null;
}

/** What the next job uses, after a save. */
export function transcriptionSavedMessage(state) {
  if (!state.enabled) return "Tersimpan. Job berikutnya memakai Whisper di server ini.";
  if (state.key === "llm" || state.key === "own") return "Tersimpan. Job berikutnya mencoba Groq dulu.";
  return "Tersimpan. Isi API key Groq supaya Groq bisa dipakai.";
}

const ERRORS = Object.freeze({
  secret_missing: "Kunci enkripsi pengaturan belum tersedia di server.",
  settings_unavailable: "Folder pengaturan di server belum bisa dipakai.",
  csrf_rejected: "Permintaan ditolak. Muat ulang halaman, lalu coba lagi.",
});

/** The message of a refused change: `{status, code, error}` from the answer (status 0: offline). */
export function transcriptionErrorMessage({ status, code, error } = {}) {
  if (status === 401) return SESSION_TEXT;
  if (status === 0) return "Koneksi terputus. Coba lagi.";
  if (code === "invalid" && typeof error === "string" && error) return error;
  return Object.hasOwn(ERRORS, code) ? ERRORS[code] : "Pengaturan transkripsi gagal disimpan. Coba lagi.";
}
