// Stage, reason and warning codes to catalog text (rombak 07 §10.4, i18n M5). The engine
// (src/ai_clipper/i18n_codes.py) and the worker write codes beside their Indonesian prose:
//
// - job.stageCode + job.stageParams beside job.stageDetail          -> stage.<code>
// - clip.reasonCodes [{code, params}], one per clip.reasons item     -> reason.<code>
//   ({code: "text", params: {text}} is the LLM's own words: shown as written)
// - clip.warningCodes [{code, params}] (warnings naming that clip)   -> reason.warning.<code>
// - job.selectionV3.warnings ("code[:detail]" strings)               -> warningCodes() first
//
// A job written before the codes (no stageCode, no reasonCodes) shows its prose as before. Pure
// and client-safe: the worker sanitizes with the same lists before it stores anything.
import { shownStageDetail } from "../stage-detail.mjs";
import { d } from "./descriptor.mjs";

const NUMBER = "number";
const STRING = "string";
const TAGS = "tags";

// Every stage code and the names of its params (all numbers). The engine's come first
// (i18n_codes.STAGE_CODES), then the worker's, then codes of later milestones (04 §A8.1, §B1).
export const STAGE_PARAMS = Object.freeze({
  analyze_video: [], captions_upload: [], captions_check: [], transcribe_groq: [],
  transcribe_groq_progress: ["percent"], transcribe_audio: [], transcribe_progress: ["percent"],
  audio_analysis: [], select_llm: [], select_heuristic: [], select_ranges: [], select_moments: [],
  packaging: [], render_clip: ["index", "total"], finalizing: [],
  candidates_generating: [], candidates_features: [], candidates_shortlist: [], candidates_media: [], candidates_ready: [],
  // web/scripts/run-job.mjs
  captions_fetch: [], engine_prepare: [], captions_upload_ready: [], engine_busy: [],
  clips_ready: [], clips_partial: ["ready", "total", "failed"], stopped_error: [],
  // web/lib/primary-job-queue.mjs, web/lib/job-deletion.mjs
  storage_insufficient: [], max_attempts: [], canceled_before_finish: [], worker_spawn_failed: [], deleting: [],
  // later milestones: auto layout (RF), downloads (FETCH)
  reframe: [], fetch_preflight: [], fetch_audio: [], fetch_video: [], fetch_cache_hit: [], fetch_wait_video: [],
});
export const STAGE_CODES = Object.freeze(Object.keys(STAGE_PARAMS));

export const TEXT_REASON = "text";

// Every reason code (i18n_codes.REASON_CODES) and its params with their types.
export const REASON_PARAMS = Object.freeze({
  open_question: { run: NUMBER }, open_setup: { run: NUMBER }, open_story: {}, open_contrast: {},
  open_reveal: {}, open_number: {}, open_cold_open: {}, open_plain: {},
  hook_line: { offset: NUMBER, text: STRING }, hook_line_tagged: { offset: NUMBER, text: STRING, tags: TAGS },
  teaser_echo: {}, end_laugh: {}, end_recap: {}, end_pause: { gap: NUMBER }, end_question: {},
  laughs: { count: NUMBER }, silence: { ratio: NUMBER },
  penalty_teaser: {}, penalty_sponsor: {}, penalty_segue: {}, penalty_outro: {}, penalty_greeting: {},
  penalty_small_talk: {}, penalty_suspect: {}, penalty_fillers: {}, penalty_dense_laughs: {},
  similar_topic: {},
  cold_open: { seconds: NUMBER }, focus_fill: {}, heuristic_fill: {},
  trend: { title: STRING }, trend_sensitive: { title: STRING }, manual_range: { label: STRING },
  llm_rerank: { score: NUMBER },
});
export const REASON_CODES = Object.freeze(Object.keys(REASON_PARAMS));
export const REASON_TAGS = Object.freeze(["confession", "insider", "reveal", "contrast", "stakes", "superlative", "number", "reported", "story"]);

const COUNT = ["count"];
const CLIP = ["clip"];
const DETAIL = ["detail"];
// i18n_codes.WARNING_PARAMS: the parts after "code:", split at ":" (the last name takes the
// rest); count, clip and chunk are numbers.
export const WARNING_PARAMS = Object.freeze({
  media_probe_failed: [], subtitle_rejected: DETAIL, captions_missing: [], captions_rejected: DETAIL,
  groq_fallback: DETAIL, no_word_timestamps: [], quantized_timestamps: [], punctuation_collapse: DETAIL,
  suspect_segments: COUNT, audio_unavailable: DETAIL, trend_context_invalid: [], trend_items_skipped: COUNT,
  llm_unavailable: DETAIL, llm_disabled: [], llm_not_configured: [], llm_failed: DETAIL, llm_chunked: COUNT,
  llm_chunk_failed: ["chunk", "detail"], llm_dropped: ["count", "detail"], llm_no_moments: DETAIL,
  llm_retry: ["mode", "count"], llm_retry_failed: DETAIL, llm_rerank_failed: DETAIL, llm_filled: COUNT,
  snap_dropped: COUNT, trend_ref_ungrounded: COUNT, trend_packaging_ungrounded: COUNT,
  trend_sensitive_humor: COUNT, focus_terms_unmatchable: COUNT, focus_literal_ungrounded: COUNT,
  focus_packaging_ungrounded: COUNT, focus_few_matches: COUNT, focus_topup: COUNT, focus_topup_failed: DETAIL,
  focus_topup_skipped: DETAIL, few_clips: COUNT, no_transcript: [], clip_trimmed_to_media: CLIP,
  cold_open_beyond_media: CLIP, clip_beyond_media: CLIP, llm_providers: COUNT, llm_models: COUNT,
  engine_fallback: CLIP, clip_failed: CLIP, thumbnail_failed: CLIP, auto_reframe_failed: CLIP,
  pipeline_failed: DETAIL,
});
export const WARNING_CODES = Object.freeze(Object.keys(WARNING_PARAMS));

const INTEGER_NAMES = new Set(["count", "clip", "chunk"]);
const MAX_NUMBER = 1_000_000;
const MAX_TEXT = 300;
const MAX_DETAIL = 96;
const MAX_ENTRIES = 50;
const DETAIL_TEXT = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,95}$/;
// Control and format characters never reach the page (the reasons sanitizer drops them too).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (table, key) => typeof key === "string" && Object.hasOwn(table, key);
const safeNumber = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_NUMBER;
const safeString = (value, limit) => typeof value === "string" && value.trim() !== "" && value.length <= limit && !UNSAFE.test(value);

// --- Stage -------------------------------------------------------------------------------------

/** { stageCode, stageParams } of a known code with valid params, else both null. */
export function sanitizeStageCode(code, params) {
  if (!own(STAGE_PARAMS, code)) return { stageCode: null, stageParams: null };
  const names = STAGE_PARAMS[code];
  if (!names.length) return { stageCode: code, stageParams: null };
  if (!isPlainObject(params) || !names.every((name) => safeNumber(params[name]))) return { stageCode: null, stageParams: null };
  return { stageCode: code, stageParams: Object.fromEntries(names.map((name) => [name, params[name]])) };
}

/** stage.<stageCode> when the job has a known code, else its stage detail (old jobs), else null. */
export function stageText(t, job) {
  const { stageCode, stageParams } = sanitizeStageCode(job?.stageCode, job?.stageParams);
  if (stageCode && t.has(`stage.${stageCode}`)) return t(`stage.${stageCode}`, stageParams ?? {});
  return shownStageDetail(job);
}

// --- Reasons -----------------------------------------------------------------------------------

function reasonEntry(entry) {
  if (!isPlainObject(entry) || !isPlainObject(entry.params)) return null;
  const { code, params } = entry;
  if (code === TEXT_REASON) return safeString(params.text, MAX_TEXT) ? { code, params: { text: params.text } } : null;
  if (!own(REASON_PARAMS, code)) return null;
  const clean = {};
  for (const [name, type] of Object.entries(REASON_PARAMS[code])) {
    const value = params[name];
    if (type === NUMBER && !safeNumber(value)) return null;
    if (type === STRING && !safeString(value, MAX_TEXT)) return null;
    if (type === TAGS && !(Array.isArray(value) && value.length && value.length <= REASON_TAGS.length && value.every((tag) => REASON_TAGS.includes(tag)))) return null;
    clean[name] = type === TAGS ? [...value] : value;
  }
  return { code, params: clean };
}

/** The coded reasons of a manifest clip (reason_codes) when every entry is valid, else null. */
export function sanitizeReasonCodes(value) {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ENTRIES) return null;
  const entries = value.map(reasonEntry);
  return entries.every(Boolean) ? entries : null;
}

/** One coded reason in the UI language: the LLM's own words as written. */
export function reasonText(t, entry) {
  const clean = reasonEntry(entry);
  if (!clean) return null;
  if (clean.code === TEXT_REASON) return clean.params.text;
  const params = { ...clean.params };
  if (params.tags) params.tags = params.tags.map((tag) => t(`reason.tag.${tag}`)).join(", ");
  return t(`reason.${clean.code}`, params);
}

/** A clip's reasons in the UI language; a clip without codes (old jobs) keeps its own text. */
export function reasonTexts(t, clip) {
  const coded = sanitizeReasonCodes(clip?.reasonCodes);
  if (coded) return coded.map((entry) => reasonText(t, entry));
  return Array.isArray(clip?.reasons) ? clip.reasons.filter((reason) => typeof reason === "string" && reason) : [];
}

// --- Warnings ----------------------------------------------------------------------------------

const DIGITS = /^\d{1,9}$/;

/** { code, params } of one "code[:detail]" warning, or null (unknown code, detail that does not fit). */
export function warningCode(warning) {
  if (typeof warning !== "string") return null;
  const colon = warning.indexOf(":");
  const code = colon < 0 ? warning : warning.slice(0, colon);
  const detail = colon < 0 ? "" : warning.slice(colon + 1);
  if (!own(WARNING_PARAMS, code)) return null;
  const names = WARNING_PARAMS[code];
  if (!names.length) return detail ? null : { code, params: {} };
  if (!detail) return names === DETAIL ? { code, params: {} } : null;
  const parts = [];
  let rest = detail;
  for (let index = 0; index < names.length - 1; index += 1) {
    const at = rest.indexOf(":");
    if (at < 0) return null;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  parts.push(rest);
  const params = {};
  for (const [index, name] of names.entries()) {
    const part = parts[index];
    const value = DIGITS.test(part) ? Number(part) : part;
    if (INTEGER_NAMES.has(name) && typeof value !== "number") return null;
    if (typeof value === "string" && !(value.length <= MAX_DETAIL && DETAIL_TEXT.test(value))) return null;
    params[name] = value;
  }
  return { code, params };
}

/** The coded form of a list of "code[:detail]" warnings (unknown ones left out), in order. */
export function warningCodes(warnings) {
  if (!Array.isArray(warnings)) return [];
  return warnings.map(warningCode).filter(Boolean).slice(0, MAX_ENTRIES);
}

function warningEntry(entry) {
  if (!isPlainObject(entry) || !own(WARNING_PARAMS, entry.code) || !isPlainObject(entry.params)) return null;
  const names = WARNING_PARAMS[entry.code];
  const params = {};
  for (const name of names) {
    const value = entry.params[name];
    if (value === undefined && names === DETAIL) continue;
    if (INTEGER_NAMES.has(name) ? !(Number.isSafeInteger(value) && safeNumber(value)) : !(typeof value === "number" ? safeNumber(value) : typeof value === "string" && DETAIL_TEXT.test(value))) return null;
    params[name] = value;
  }
  if (Object.keys(entry.params).some((name) => !names.includes(name))) return null;
  return { code: entry.code, params };
}

/** The coded warnings of a manifest clip (warning_codes): the valid entries, or null for none. */
export function sanitizeWarningCodes(value) {
  if (!Array.isArray(value)) return null;
  const entries = value.slice(0, MAX_ENTRIES).map(warningEntry).filter(Boolean);
  return entries.length ? entries : null;
}

/** reason.warning.<code> of a coded warning or a "code[:detail]" string as a descriptor, else null. */
export function warningDescriptor(warning) {
  const entry = typeof warning === "string" ? warningCode(warning) : warningEntry(warning);
  if (!entry) return null;
  const params = { ...entry.params };
  // A code whose detail is optional ("audio_unavailable") still names it in a select.
  for (const name of WARNING_PARAMS[entry.code]) if (params[name] === undefined) params[name] = "";
  return d(`reason.warning.${entry.code}`, params);
}

/** reason.warning.<code> of a coded warning or a "code[:detail]" string, else null. */
export function warningText(t, warning) {
  const descriptor = warningDescriptor(warning);
  return descriptor ? t(descriptor.key, descriptor.values ?? {}) : null;
}
