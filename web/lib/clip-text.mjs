// "Ubah" and "Tulis ulang" in the project page's detail panel (plan 2026-10-20 P2): the words on
// screen, the form's state and the two requests. Client-safe; the routes are clip-text-api.mjs.
import { helpHref } from "./help-catalog.mjs";
import { formatNumber } from "./i18n/format.mjs";

// The job's own limits (lib/jobs.mjs CLIP_TEXT_LIMITS title and storedDescription; a test keeps
// them equal, that module is server-only). Characters are counted as the server counts them.
export const CLIP_TEXT_EDIT_LIMITS = Object.freeze({ title: 100, description: 1200 });

export const CLIP_TEXT_COPY = Object.freeze({
  edit: "Ubah",
  rewrite: "Tulis ulang",
  rewriting: "Menulis…",
  pending: "AI sedang menulis judul dan deskripsi baru dari transkrip klip ini…",
  suggestion: "Saran AI",
  use: "Pakai",
  discard: "Buang",
  titleLabel: "Judul",
  descriptionLabel: "Deskripsi",
  descriptionHint: "Tulis tagar di baris terakhir, misalnya #podcast #fyp.",
  save: "Simpan",
  saving: "Menyimpan…",
  cancel: "Batal",
  saved: "Judul dan deskripsi tersimpan.",
  failed: "Tulis ulang gagal",
  help: "Cara memperbaiki",
  settings: "Buka Pengaturan",
});

const SAVE_FAILED = "Teks belum tersimpan. Coba lagi.";
const SAVE_OFFLINE = "Teks belum tersimpan. Periksa koneksi, lalu coba lagi.";
const REWRITE_FAILED = "Tulis ulang tidak tersedia sekarang. Coba lagi sebentar lagi.";
const REWRITE_OFFLINE = "Tulis ulang gagal tersambung. Periksa koneksi, lalu coba lagi.";
const FIELD_OF = Object.freeze({ title_empty: "title", title_too_long: "title", description_too_long: "description" });
// Failures the owner fixes in Pengaturan (AI off, no provider, a provider that refuses).
const SETTINGS_CODES = new Set(["llm_disabled", "llm_settings", "llm_unavailable"]);

const characters = (text) => Array.from(text).length;
const number = (value) => formatNumber(value);
const oneLine = (text) => (typeof text === "string" ? text.replace(/\s+/gu, " ").trim() : "");
// Line ends and the spaces around lines, as the server cleans them.
const block = (text) => (typeof text === "string"
  ? text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim()
  : "");

/** The form's starting text: the clip's title and its whole description (hashtag line included). */
export function clipTextDraft(clip) {
  return {
    title: typeof clip?.title === "string" ? clip.title : "",
    description: typeof clip?.description === "string" ? clip.description : "",
  };
}

/**
 * The form: a counter per field (`…Over` past its limit), each field's problem, and whether
 * "Simpan" has a change to send.
 */
export function clipTextForm(draft, clip) {
  const title = oneLine(draft?.title);
  const description = block(draft?.description);
  const titleLength = characters(title);
  const descriptionLength = characters(description);
  const titleProblem = !title ? "Judul tidak boleh kosong."
    : titleLength > CLIP_TEXT_EDIT_LIMITS.title ? `Judul paling banyak ${CLIP_TEXT_EDIT_LIMITS.title} karakter.` : null;
  const descriptionProblem = descriptionLength > CLIP_TEXT_EDIT_LIMITS.description
    ? `Deskripsi paling banyak ${number(CLIP_TEXT_EDIT_LIMITS.description)} karakter.` : null;
  const saved = clipTextDraft(clip);
  const dirty = title !== oneLine(saved.title) || description !== block(saved.description);
  return {
    titleCount: `${number(titleLength)}/${number(CLIP_TEXT_EDIT_LIMITS.title)}`,
    descriptionCount: `${number(descriptionLength)}/${number(CLIP_TEXT_EDIT_LIMITS.description)}`,
    titleOver: titleLength > CLIP_TEXT_EDIT_LIMITS.title,
    descriptionOver: descriptionLength > CLIP_TEXT_EDIT_LIMITS.description,
    titleProblem,
    descriptionProblem,
    dirty,
    canSave: dirty && !titleProblem && !descriptionProblem,
  };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const loginRedirect = (jobId) => ({ type: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${jobId}`)}` });

function sendJson(fetchImpl, url, method, body, signal) {
  return fetchImpl(url, {
    method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), cache: "no-store", signal,
  });
}

/** "Simpan": `{type: "saved", clip}`, `{type: "error", field, message}` or `{type: "redirect"}`. */
export async function saveClipText(jobId, index, draft, { fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    response = await sendJson(fetchImpl, `/api/jobs/${encodeURIComponent(jobId)}/clip-text`, "PATCH",
      { index, title: draft.title, description: draft.description }, signal);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { type: "error", field: null, message: SAVE_OFFLINE };
  }
  if (response.status === 401) return loginRedirect(jobId);
  const body = await readJson(response);
  if (response.ok && body?.clip && typeof body.clip === "object" && body.clip.index === index) return { type: "saved", clip: body.clip };
  const message = !response.ok && typeof body?.error === "string" && body.error ? body.error : SAVE_FAILED;
  return { type: "error", field: FIELD_OF[body?.code] ?? null, message };
}

/** Why a "Tulis ulang" failed, with the /bantuan entry and Pengaturan when they help. */
function rewriteFailure(body, fallback) {
  const code = typeof body?.code === "string" ? body.code : null;
  const message = typeof body?.error === "string" && body.error ? body.error : fallback;
  const help = (typeof body?.llmCode === "string" && helpHref(body.llmCode))
    || (code === "timeout" ? helpHref("timeout") : code === "llm_disabled" ? helpHref("not_configured") : null);
  return { type: "error", code, title: CLIP_TEXT_COPY.failed, message, help, settings: SETTINGS_CODES.has(code) ? "/settings" : null };
}

/** "Tulis ulang": `{type: "suggestion", suggestion: {title, description}}`, an error or a redirect. */
export async function rewriteClipText(jobId, index, { fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    response = await sendJson(fetchImpl, `/api/jobs/${encodeURIComponent(jobId)}/clip-text/rewrite`, "POST", { index }, signal);
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return rewriteFailure(null, REWRITE_OFFLINE);
  }
  if (response.status === 401) return loginRedirect(jobId);
  const body = await readJson(response);
  const suggestion = body?.suggestion;
  if (response.ok && typeof suggestion?.title === "string" && suggestion.title.trim() && typeof suggestion.description === "string") {
    return { type: "suggestion", suggestion: { title: suggestion.title, description: suggestion.description } };
  }
  return rewriteFailure(response.ok ? null : body, REWRITE_FAILED);
}

/** `job` with `clip` in place of the clip that has its number. */
export function replaceClip(job, clip) {
  if (!job || !Array.isArray(job.clips)) return job;
  return { ...job, clips: job.clips.map((item) => (item?.index === clip.index ? clip : item)) };
}
