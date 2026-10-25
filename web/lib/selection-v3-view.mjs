// Presentation helpers for the clips and selection summaries of the current method. Client-safe:
// no Node built-ins, so both the dashboard and the project page can import it. Copy comes back as
// catalog descriptors ({ key, values }, lib/i18n/descriptor.mjs; msg(t, …) gives the text); the
// clip's own words (titles, terms, trend titles) are data and pass as strings.

import { llmWarningHelpHref } from "./help-catalog.mjs";
import { TREND_KIND_NAMES, TREND_LIMITS, cleanLine } from "./trend-view.mjs";
import { d } from "./i18n/descriptor.mjs";
import { secondsFormat } from "./i18n/format.mjs";
import { SOURCE_LOCALE } from "./i18n/locales.mjs";
import { reasonText, sanitizeReasonCodes, warningDescriptor } from "./i18n/stage.mjs";

const frozen = (table) => Object.freeze(Object.fromEntries(Object.entries(table).map(([id, value]) => [id, Object.freeze(value)])));

export const ARCHETYPE_LABELS = frozen({
  curiosity_gap: d("project.archetype.curiosity_gap"),
  controversial_claim: d("project.archetype.controversial_claim"),
  confession: d("project.archetype.confession"),
  insider_secret: d("project.archetype.insider_secret"),
  story_twist: d("project.archetype.story_twist"),
  number_proof: d("project.archetype.number_proof"),
  conflict: d("project.archetype.conflict"),
  humor: d("project.archetype.humor"),
  relatable_pain: d("project.archetype.relatable_pain"),
  emotional: d("project.archetype.emotional"),
  practical_tip: d("project.archetype.practical_tip"),
  other: d("project.archetype.other"),
});

export const SCORE_LABELS = frozen({
  hook: d("project.scoreName.hook"),
  standalone: d("project.scoreName.standalone"),
  payoff: d("project.scoreName.payoff"),
  emotion: d("project.scoreName.emotion"),
  shareability: d("project.scoreName.shareability"),
});

export function archetypeLabel(code) {
  if (typeof code !== "string" || !code) return null;
  return Object.hasOwn(ARCHETYPE_LABELS, code) ? ARCHETYPE_LABELS[code] : ARCHETYPE_LABELS.other;
}

export function formatTenths(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return secondsFormat(SOURCE_LOCALE).format(value);
}

/** A 0–10 score, or null when the value is not on that scale (V1 scores are not). */
export function tenPointScore(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}

export function scoreRows(scores) {
  if (!scores || typeof scores !== "object") return [];
  return Object.keys(SCORE_LABELS)
    .filter((name) => tenPointScore(scores[name]) !== null)
    .map((name) => ({ name, label: SCORE_LABELS[name], value: scores[name], percent: scores[name] * 10 }));
}

// Clips picked by the current selection carry one of these sources; their score is 0–10.
const CURRENT_SELECTION_SOURCES = new Set(["llm", "heuristic"]);

/**
 * The score block of a clip: `{ total, rows }` (total may be null), or null for a clip the
 * current selection did not pick. Older clips have a score on another scale, even when it
 * happens to fall between 0 and 10, so they show none.
 */
export function clipScoreView(clip) {
  if (!CURRENT_SELECTION_SOURCES.has(clip?.selectionSource)) return null;
  const total = tenPointScore(clip.score);
  const rows = scoreRows(clip.scores);
  return total === null && !rows.length ? null : { total, rows };
}

// The engine appends its rerank score as a reason ("Peringkat ulang LLM: 4,8/10"). It is
// bookkeeping of the method, kept in the artifact and left off the page.
const BOOKKEEPING_REASON = /^Peringkat ulang LLM:/;

/** "Kenapa dipilih": the clip's reasons as text, without the engine's own bookkeeping. */
export function clipReasons(clip) {
  const reasons = Array.isArray(clip?.reasons) ? clip.reasons : [];
  return reasons.filter((reason) => typeof reason === "string" && reason.trim() && !BOOKKEEPING_REASON.test(reason.trim()));
}

/**
 * "Kenapa dipilih" in the UI language: the coded reasons (i18n M5) through the catalog, without
 * the rerank bookkeeping; a clip without valid codes (old jobs) keeps clipReasons. `t` is a root
 * translator whose messages include the `reason` namespace.
 */
export function clipReasonTexts(t, clip) {
  const coded = sanitizeReasonCodes(clip?.reasonCodes);
  if (!coded) return clipReasons(clip);
  return coded.filter((entry) => entry.code !== "llm_rerank").map((entry) => reasonText(t, entry)).filter(Boolean);
}

/**
 * The description split into its body and the hashtags shown as chips. The
 * persisted description ends with the hashtag line (the long-standing caption
 * convention), which is not repeated in the body.
 */
export function captionParts(clip) {
  const description = typeof clip?.description === "string" ? clip.description : "";
  const hashtags = Array.isArray(clip?.hashtags) ? clip.hashtags.filter((tag) => typeof tag === "string" && tag) : [];
  const line = hashtags.join(" ");
  if (line && description.endsWith(line)) {
    return { body: description.slice(0, -line.length).trimEnd(), hashtags };
  }
  return { body: description, hashtags: hashtags.filter((tag) => !description.includes(tag)) };
}

/**
 * The text every "Salin caption" button copies: title, blank line, description (+ missing
 * hashtags); the title alone when the owner emptied the description.
 */
export function clipCaptionText(clip) {
  const title = typeof clip?.title === "string" ? clip.title : "";
  const description = typeof clip?.description === "string" ? clip.description : "";
  const missing = captionParts(clip).hashtags.filter((tag) => !description.includes(tag));
  const body = missing.length ? `${description}${description ? "\n\n" : ""}${missing.join(" ")}` : description;
  return body ? `${title}\n\n${body}` : title;
}

// A poster the engine wrote beside the clip (clip-XX.jpg), served by the job
// files route. The public job API only keeps URLs of this exact shape.
export const CLIP_THUMBNAIL_URL = /^\/api\/jobs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/files\/output\/(clip-\d{1,4}\.jpg)$/i;

/** The `<video poster>` for a clip, or undefined (old jobs) so the attribute is omitted. */
export function clipPosterUrl(clip) {
  const url = clip?.thumbnailUrl;
  return typeof url === "string" && CLIP_THUMBNAIL_URL.test(url) ? url : undefined;
}

const MAX_TREND_CHIPS = 5;

/**
 * "Nyambung tren: <judul>" chips for the trends the engine grounded in this
 * clip's transcript (`clip.trends`: [{ id, title, kind }]). An empty list for
 * every clip without trends, so those clips render exactly as before.
 * Titles are cleaned and bounded here; they are only ever rendered as text.
 */
export function clipTrendChips(clip) {
  const trends = Array.isArray(clip?.trends) ? clip.trends : [];
  const chips = [];
  const seen = new Set();
  for (const trend of trends) {
    if (chips.length >= MAX_TREND_CHIPS) break;
    if (!trend || typeof trend !== "object" || Array.isArray(trend)) continue;
    const title = Array.from(cleanLine(trend.title)).slice(0, TREND_LIMITS.title).join("");
    if (!title) continue;
    const id = typeof trend.id === "string" ? cleanLine(trend.id).slice(0, 120) : "";
    const key = id || `title:${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const kind = typeof trend.kind === "string" && trend.kind !== "other" && Object.hasOwn(TREND_KIND_NAMES, trend.kind) ? TREND_KIND_NAMES[trend.kind] : null;
    chips.push({ key, title, label: d("project.trendChip", { title }), kindLabel: kind });
  }
  return chips;
}

// Tren and Fokus klip summary codes (engine: pipeline.py and selection_v3.py) explained on the
// page; their text is reason.warning.<code> (lib/i18n/stage.mjs). Other codes stay technical.
const COUNTED_WARNINGS = new Set([
  "trend_items_skipped", "trend_ref_ungrounded", "trend_packaging_ungrounded", "trend_sensitive_humor",
  "focus_few_matches", "focus_literal_ungrounded", "focus_packaging_ungrounded", "focus_terms_unmatchable", "focus_topup",
]);
// Fokus klip top-up (engine: llm_selection.py): why the one extra request was not used.
const FOCUS_TOPUP_SKIPPED = new Set(["budget", "deadline", "context"]);
// Transkripsi lewat Groq (engine: pipeline.py, transcribe_groq.py): why Groq was not used. Local
// Whisper always made the transcript instead.
const GROQ_FALLBACK_REASONS = new Set([
  "no_key", "auth", "rate_limited", "too_long", "too_large", "audio_failed", "model_unavailable",
  "server_error", "http_error", "timeout", "network", "malformed", "empty", "error",
]);
// An uploaded .srt the engine could not use (pipeline.py): the transcript came from the audio.
const SUBTITLE_REJECTED = new Set(["invalid", "empty", "duration_mismatch"]);

function explainedWarning(code) {
  if (typeof code !== "string") return false;
  const subtitle = /^subtitle_rejected:([a-z_]{1,32})$/.exec(code);
  if (subtitle) return SUBTITLE_REJECTED.has(subtitle[1]);
  if (code === "trend_context_invalid") return true;
  const groq = /^groq_fallback:([a-z_]{1,32})$/.exec(code);
  if (groq) return GROQ_FALLBACK_REASONS.has(groq[1]);
  if (code === "focus_few_matches:0" || code === "focus_topup:0") return true;
  const topup = /^focus_topup_(failed|skipped):([a-z][a-z0-9_]{0,63})$/.exec(code);
  if (topup?.[1] === "failed") return true;
  if (topup?.[1] === "skipped") return FOCUS_TOPUP_SKIPPED.has(topup[2]);
  const counted = /^([a-z_]+):([1-9]\d{0,5})$/.exec(code);
  return Boolean(counted) && COUNTED_WARNINGS.has(counted[1]);
}

/** The explanation of a trend, focus, Groq or subtitle warning code of the selection summary (a descriptor), or null. */
export function selectionWarningLabel(code) {
  return explainedWarning(code) ? warningDescriptor(code) : null;
}

// Explained warnings the owner acts on: shown as notices above the clips. Every other explained
// warning is a note in a closed list; unexplained codes stay in the artifact.
const ACTIONABLE_WARNINGS = /^(trend_sensitive_humor|focus_terms_unmatchable|subtitle_rejected):|^trend_items_skipped:|^trend_context_invalid$|^groq_fallback:(no_key|auth)$/;
// A Groq key that is missing or refused is fixed in Pengaturan.
const SETTINGS_PAGE_WARNINGS = /^groq_fallback:(no_key|auth)$/;
// Warnings fixed on the Konteks Tren page link there.
const TREND_PAGE_WARNINGS = /^trend_(context_invalid|items_skipped)(?::|$)/;

function summaryWarnings(job) {
  const summary = job?.selectionV3;
  if (!summary || typeof summary !== "object" || summary.mode !== "v3" || !Array.isArray(summary.warnings)) return [];
  return summary.warnings.filter((code) => typeof code === "string" && selectionWarningLabel(code) !== null);
}

/** "Catatan pemilihan": the explained warnings that need no action. */
export function selectionNotes(job) {
  return summaryWarnings(job).filter((code) => !ACTIONABLE_WARNINGS.test(code)).map(selectionWarningLabel);
}

// --- Fokus klip (docs/plans/2026-09-25-fokus-klip.md §1, §3) ------------------------------------
// The owner's focus terms and note are still untrusted text for the engine's prompt: the
// dashboard and the job API normalise and bound them the same way trend items are (NFC; no
// control, format or other invisible characters; spaces collapsed; code-point lengths).

export const FOCUS_LIMITS = Object.freeze({ terms: 8, termMin: 2, termMax: 40, note: 200 });
export const FOCUS_MATCHES = Object.freeze(["literal", "semantic", "none"]);
export const FOCUS_MODES = Object.freeze(["prefer"]);

const FOCUS_LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const FOCUS_INVISIBLE = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

function focusCodePoints(value) {
  return Array.from(value).length;
}

/** One line of focus text as the engine will see it, or "" for anything that is not a string. */
export function normalizeFocusText(value) {
  if (typeof value !== "string") return "";
  const wellFormed = typeof value.toWellFormed === "function" ? value.toWellFormed() : value;
  return wellFormed
    .replace(FOCUS_LINE_BREAKS, " ")
    .replace(FOCUS_INVISIBLE, "")
    .replace(/\s+/gu, " ")
    .trim()
    .normalize("NFC");
}

// The engine's function words and fillers (src/ai_clipper/focus.py FOCUS_STOPWORDS): a term
// made only of these, or of words under three letters, never matches a transcript literally.
// web/tests/focus.test.mjs checks the list against the engine.
export const FOCUS_STOPWORDS = Object.freeze([
  "yang", "dan", "di", "ke", "dari", "ini", "itu", "aja", "saja", "dulu", "udah", "sudah",
  "lagi", "juga", "ada", "apa", "gak", "nggak", "enggak", "ngga", "tidak", "bukan",
  "kita", "kami", "kamu", "lu", "lo", "gue", "gua", "aku", "dia", "mereka", "banget",
  "sama", "buat", "untuk", "dengan", "pada", "jadi", "kalau", "kalo", "tapi", "atau",
  "karena", "soal", "masih", "bisa", "mau", "akan", "sih", "dong", "deh", "kok", "nih",
  "tuh", "yah", "gitu", "begitu", "kayak", "seperti", "emang", "memang", "terus", "sampai",
  "sampe", "semua", "lebih", "paling", "sangat", "satu", "dua", "tiga", "gimana", "kenapa",
  "mana", "siapa", "kapan", "cuma", "cuman", "doang", "sekarang", "nanti", "tadi", "the",
  "and", "for", "you", "with", "this", "that",
  "ayo", "yuk", "nah", "kan", "loh", "lho", "wah", "wow", "oke", "okay", "yes", "halo",
  "guys", "gaes", "wkwk", "wkwkwk", "haha", "hahaha",
]);
const FOCUS_STOPWORD_SET = new Set(FOCUS_STOPWORDS);
const FOCUS_MIN_LETTERS = 3;

// Folds like Python's str.casefold(): the lower-upper-lower round trip ("Straße" = "STRASSE",
// "ﬁlm" = "FILM", final sigma).
function foldFocusText(value) {
  return normalizeFocusText(value).toLowerCase().toUpperCase().toLowerCase();
}

/** The words a focus term matches as, like the engine's tokens: folded, accent-free letters and digits. */
export function focusTermWords(value) {
  return foldFocusText(value).normalize("NFKD").replace(/\p{M}+/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Terms are the same term when this key is equal: the words they match as, so case, accents and
 * punctuation do not count ("Jomok!" = "jomok", "K pop" = "k-pop"). Terms the engine would reject
 * as repeated (Python casefold) are always one term here. A term without words keys by its text.
 */
export function focusTermKey(value) {
  const words = focusTermWords(value);
  if (words.length) return words.join(" ");
  return foldFocusText(value).normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
}

/** Whether the engine can ever find `term` in a transcript literally (a word of three letters or more that is no stopword). */
export function focusTermMatchable(term) {
  return focusTermWords(term).some((word) => (word.match(/\p{L}/gu)?.length ?? 0) >= FOCUS_MIN_LETTERS && !FOCUS_STOPWORD_SET.has(word));
}

/** The dashboard's note for chips the transcript can never say literally, or null. */
export function focusTermsHint(terms, llmMode) {
  const unmatchable = (Array.isArray(terms) ? terms : []).filter((term) => !focusTermMatchable(term));
  if (!unmatchable.length) return null;
  const names = unmatchable.map((term) => `“${term}”`).join(", ");
  return llmMode === "off" ? d("dashboard.focus.unmatchableOff", { names }) : d("dashboard.focus.unmatchable", { names });
}

// Pasted separators that become commas: line breaks (a single-line input would turn them into
// spaces), tabs and semicolons. A paste with commas alone is split on them as well.
const FOCUS_PASTE_SEPARATORS = /[\t\n\v\f\r\u0085\u2028\u2029;]+/g;

/**
 * The chip text for a paste into the chip input: the draft with the pasted text in place of the
 * selection, separators as commas, or null for a paste without a separator (it is typed as is).
 */
export function pastedFocusTerms(draft, pasted, start, end) {
  const text = String(pasted ?? "");
  if (!/[\t\n\v\f\r\u0085\u2028\u2029;,]/.test(text)) return null;
  const value = String(draft ?? "");
  const from = Number.isSafeInteger(start) ? start : value.length;
  const to = Number.isSafeInteger(end) ? end : from;
  return `${value.slice(0, from)}${text}${value.slice(to)}`.replace(FOCUS_PASTE_SEPARATORS, ",");
}

/** Focus terms as typed: separated by commas or line breaks, cleaned, blanks dropped. */
export function splitFocusTerms(text) {
  return String(text ?? "").split(/[,\n\r]/).map(normalizeFocusText).filter(Boolean);
}

function focusTermPreview(term) {
  const points = Array.from(term);
  return points.length > 20 ? `${points.slice(0, 20).join("")}…` : term;
}

/**
 * Adds the typed text to the chips. Valid terms (2–40 characters, new, at most 8 in all) become
 * chips; a duplicate is dropped; anything else stays in the input (`pending`) with `error` (a
 * descriptor, or "" for none).
 */
export function addFocusTerms(terms, text) {
  const next = [...terms];
  const keys = new Set(next.map(focusTermKey));
  const rejected = [];
  let error = "";
  for (const term of splitFocusTerms(text)) {
    const length = focusCodePoints(term);
    const key = focusTermKey(term);
    let problem = "";
    if (length < FOCUS_LIMITS.termMin) problem = d("dashboard.focus.tooShort", { term, min: FOCUS_LIMITS.termMin });
    else if (length > FOCUS_LIMITS.termMax) problem = d("dashboard.focus.tooLong", { term: focusTermPreview(term), max: FOCUS_LIMITS.termMax });
    else if (keys.has(key)) {
      error ||= d("dashboard.focus.duplicate", { term });
      continue;
    } else if (next.length >= FOCUS_LIMITS.terms) problem = d("dashboard.focus.tooMany", { max: FOCUS_LIMITS.terms });
    if (problem) {
      error ||= problem;
      rejected.push(term);
      continue;
    }
    keys.add(key);
    next.push(term);
  }
  return { terms: next, pending: rejected.join(", "), error };
}

export function removeFocusTerm(terms, term) {
  return terms.filter((entry) => entry !== term);
}

/**
 * What the dashboard sends for the focus: `fields` is {} without focus (nothing is sent), the
 * `focusTerms`/`focusNote` form fields otherwise, or null with `error` when the job must not be
 * created yet. Text still in the chip input is committed first.
 */
export function focusFormFields({ terms = [], pending = "", note = "" } = {}) {
  const committed = normalizeFocusText(pending) ? addFocusTerms(terms, pending) : { terms: [...terms], pending: "", error: "" };
  if (committed.pending) return { ...committed, fields: null };
  const cleanNote = normalizeFocusText(note);
  if (focusCodePoints(cleanNote) > FOCUS_LIMITS.note) {
    return { ...committed, fields: null, error: d("dashboard.focus.noteTooLong", { max: FOCUS_LIMITS.note }) };
  }
  if (!committed.terms.length) {
    return cleanNote
      ? { ...committed, fields: null, error: d("dashboard.focus.noteWithoutTerms") }
      : { terms: [], pending: "", error: "", fields: {} };
  }
  return {
    terms: committed.terms,
    pending: "",
    error: "",
    fields: { focusTerms: committed.terms.join(","), ...(cleanNote ? { focusNote: cleanNote } : {}) },
  };
}

/** A list of focus terms read leniently: cleaned, 2–40 characters, unique, at most 8. */
export function cleanFocusTerms(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const terms = [];
  for (const entry of value) {
    if (terms.length >= FOCUS_LIMITS.terms) break;
    const term = normalizeFocusText(entry);
    const length = focusCodePoints(term);
    const key = focusTermKey(term);
    if (length < FOCUS_LIMITS.termMin || length > FOCUS_LIMITS.termMax || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
  }
  return terms;
}

function jobFocusTerms(job) {
  const fromSummary = cleanFocusTerms(job?.selectionV3?.focus?.terms);
  return fromSummary.length ? fromSummary : cleanFocusTerms(job?.options?.focus?.terms);
}

function focusCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** A source-video time as m:ss or h:mm:ss, or null. */
export function formatTimestamp(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/**
 * "Fokus: jomok, jomokers · 5 dari 8 klip cocok" for a job with focus terms, or null (every job
 * without focus): the terms, `countText` and `text` as descriptors. The counts come from the
 * engine's summary; without them only the terms.
 */
export function focusSummaryLine(job) {
  const terms = jobFocusTerms(job);
  if (!terms.length) return null;
  const summary = job?.selectionV3?.focus;
  const matched = focusCount(summary?.matched);
  const requested = focusCount(summary?.requested);
  const counted = matched !== null && requested !== null && requested > 0 && matched <= requested;
  const termsText = terms.join(", ");
  return {
    terms,
    termsText,
    countText: counted ? d("project.focusSummary.count", { matched, requested }) : null,
    text: counted ? d("project.focusSummary.textCount", { terms: termsText, matched, requested }) : d("project.focusSummary.text", { terms: termsText }),
  };
}

function quotedTerms(terms) {
  const shown = terms.slice(0, 2).map((term) => `'${term}'`).join(", ");
  return terms.length > 2 ? `${shown} +${terms.length - 2}` : shown;
}

/**
 * The focus label of one V3 clip: "Menyebut 'jomok' · 12:34" (checked in code against the
 * transcript), "Terkait 'jomok' (menurut AI)" (the model's claim) or "Di luar fokus". Null for
 * clips of jobs without focus, so they render exactly as before.
 */
export function clipFocusChip(clip, job) {
  const focus = clip?.focus;
  const match = focus && typeof focus === "object" && FOCUS_MATCHES.includes(focus.match) ? focus.match : null;
  if (!match) return job?.selectionV3?.focus && typeof job.selectionV3.focus === "object" ? { tone: "none", label: d("project.focusChip.outside") } : null;
  if (match === "none") return { tone: "none", label: d("project.focusChip.outside") };
  const own = cleanFocusTerms(focus.terms);
  const terms = own.length ? own : jobFocusTerms(job);
  if (match === "semantic") {
    return { tone: "semantic", label: terms.length ? d("project.focusChip.semantic", { terms: quotedTerms(terms) }) : d("project.focusChip.semanticAny") };
  }
  const at = formatTimestamp(focus.at);
  if (terms.length) {
    const named = quotedTerms(terms);
    return { tone: "literal", label: at ? d("project.focusChip.literalAt", { terms: named, at }) : d("project.focusChip.literal", { terms: named }) };
  }
  return { tone: "literal", label: at ? d("project.focusChip.literalAnyAt", { at }) : d("project.focusChip.literalAny") };
}

/** "Rentang waktu kamu" for a clip cut from a range the person typed, else null. */
export function clipRangeChip(clip) {
  return clip?.manual === true ? d("project.rangeChip") : null;
}

// Every clip came from a typed range: no moment was chosen, by AI or otherwise.
function typedRangesOnly(job) {
  return Array.isArray(job?.clips) && job.clips.length > 0 && job.clips.every((clip) => clip?.manual === true);
}

export function coldOpenLength(clip) {
  const coldOpen = clip?.coldOpen;
  if (!coldOpen || typeof coldOpen.start !== "number" || typeof coldOpen.end !== "number") return null;
  const length = coldOpen.end - coldOpen.start;
  return Number.isFinite(length) && length > 0 ? length : null;
}

/**
 * What the owner can act on after a run, as `[{ tone, title?, text, href?, action?, help? }]`:
 * the AI failed (fix the key or quota; `help` is the /bantuan entry of the recorded reason, or
 * null), the job ran without AI, or a warning with a fix (the other
 * explained warnings are selectionNotes). A clean run has none. Provider, model and prompt version
 * are provenance: they stay in the job's artifact and log (the transcript source shows only in the
 * stage summary, lib/stage-summary.mjs). A failed job is explained by its own error, not here.
 * Titles, texts and actions are descriptors; a warning's text is selectionWarningLabel(code), or
 * `label(code)` when that gives one.
 */
export function selectionNotices(job, { label = null } = {}) {
  const summary = job?.selectionV3;
  if (!summary || typeof summary !== "object" || summary.mode !== "v3") return [];
  const notices = [];
  if (summary.status === "fallback") {
    notices.push({
      tone: "warning",
      title: d("project.notice.aiFailed"),
      text: d("project.notice.aiFailedText"),
      href: "/settings",
      action: d("project.notice.openSettings"),
      help: llmWarningHelpHref(summary.warnings),
    });
  } else if (summary.status === "completed" && summary.source === "heuristic" && job?.options?.llmMode !== "off" && !typedRangesOnly(job)) {
    notices.push({
      tone: "info",
      title: d("project.notice.noAi"),
      text: d("project.notice.noAiText"),
      href: "/settings",
      action: d("project.notice.setUpAi"),
    });
  }
  for (const code of summaryWarnings(job).filter((item) => ACTIONABLE_WARNINGS.test(item))) {
    const text = (typeof label === "function" && label(code)) || selectionWarningLabel(code);
    if (TREND_PAGE_WARNINGS.test(code)) notices.push({ tone: "warning", text, href: "/trends", action: d("project.notice.openTrends") });
    else if (SETTINGS_PAGE_WARNINGS.test(code)) notices.push({ tone: "warning", text, href: "/settings", action: d("project.notice.openSettings") });
    else notices.push({ tone: "warning", text });
  }
  return notices;
}

const LLM_STATE_TONES = { active: "ok", disabled: "muted", unconfigured: "muted", unusable: "warning", invalid: "warning" };

/**
 * The dashboard badge for /api/llm/status. `status` is that route's `llm`
 * object (or null while loading or when the route failed); `llmMode` is the
 * job option the operator picked.
 */
export function llmStatusView(status, llmMode = "auto") {
  if (llmMode === "off") {
    return { tone: "muted", label: d("dashboard.llmStatus.off") };
  }
  if (!status || typeof status !== "object" || typeof status.label !== "string" || !status.label) {
    return { tone: "muted", label: d("dashboard.llmStatus.checking") };
  }
  return { tone: LLM_STATE_TONES[status.state] || "warning", label: status.label };
}
