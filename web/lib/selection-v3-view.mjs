// Presentation helpers for Selection V3 clips and summaries. Client-safe: no
// Node built-ins, so both the dashboard and the project page can import it.

import { TREND_KIND_LABELS, TREND_LIMITS, cleanLine } from "./trend-view.mjs";

export const ARCHETYPE_LABELS = Object.freeze({
  curiosity_gap: "Bikin penasaran",
  controversial_claim: "Klaim kontroversial",
  confession: "Pengakuan",
  insider_secret: "Rahasia orang dalam",
  story_twist: "Cerita dengan twist",
  number_proof: "Bukti angka",
  conflict: "Konflik",
  humor: "Humor",
  relatable_pain: "Masalah yang relate",
  emotional: "Emosional",
  practical_tip: "Tips praktis",
  other: "Lainnya",
});

export const SCORE_LABELS = Object.freeze({
  hook: "Hook",
  standalone: "Berdiri sendiri",
  payoff: "Payoff",
  emotion: "Emosi",
  shareability: "Layak dibagikan",
});

export const SELECTION_SOURCE_LABELS = Object.freeze({
  llm: "AI/LLM",
  heuristic: "Heuristik",
  v1: "V1",
});

export function archetypeLabel(code) {
  if (typeof code !== "string" || !code) return null;
  return ARCHETYPE_LABELS[code] || ARCHETYPE_LABELS.other;
}

export function selectionSourceLabel(source) {
  return SELECTION_SOURCE_LABELS[source] || null;
}

export function isV3Job(job) {
  return job?.options?.selectionMode === "v3" || Boolean(job?.selectionV3);
}

export function formatTenths(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value.toLocaleString("id-ID", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
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

/** The text every "Salin caption" button copies: title, blank line, description (+ missing hashtags). */
export function clipCaptionText(clip) {
  const title = typeof clip?.title === "string" ? clip.title : "";
  const description = typeof clip?.description === "string" ? clip.description : "";
  const missing = captionParts(clip).hashtags.filter((tag) => !description.includes(tag));
  const body = missing.length ? `${description}${description ? "\n\n" : ""}${missing.join(" ")}` : description;
  return `${title}\n\n${body}`;
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
    chips.push({ key, title, label: `Nyambung tren: ${title}`, kindLabel: TREND_KIND_LABELS[trend.kind] || null });
  }
  return chips;
}

// Konteks Tren and Fokus klip summary codes (engine: pipeline.py and selection_v3.py). Other
// codes stay technical and get no label.
const WARNING_LABELS = Object.freeze({
  trend_items_skipped: (count) => `${count} item tren rusak dilewati.`,
  trend_ref_ungrounded: (count) => `${count} tren yang disebut AI dibuang karena tidak disebut di transkrip klipnya.`,
  trend_packaging_ungrounded: (count) => `${count} klip AI menyebut tren yang tidak ada di transkripnya; judul, hook atau deskripsinya diganti dari klip itu sendiri.`,
  trend_sensitive_humor: (count) => `${count} klip lucu menyinggung tren sensitif; periksa judul dan hook-nya sebelum diunggah.`,
  focus_few_matches: (count) => `Hanya ${count} klip yang cocok dengan fokus; sisa slot diisi momen terbaik lain dengan label “Di luar fokus”.`,
  focus_literal_ungrounded: (count) => `${count} klip yang menurut AI menyebut fokus ternyata istilahnya tidak ditemukan di transkrip klip itu; labelnya diturunkan dari “Menyebut”.`,
  focus_packaging_ungrounded: (count) => `${count} klip di luar fokus memakai kata kunci fokus di judul, hook atau deskripsinya; teks itu diganti dari isi klipnya sendiri.`,
  focus_llm_outranked: (count) => `${count} momen usulan AI kalah prioritas dari momen yang menyebut kata kunci fokus, jadi semua slot diisi momen fokus dari pemilih heuristik.`,
});

/** An Indonesian explanation of a trend or focus warning code of the V3 summary, or null. */
export function selectionWarningLabel(code) {
  if (code === "trend_context_invalid") return "File konteks tren job rusak atau hilang; job jalan tanpa tren.";
  if (code === "focus_few_matches:0") return "Tidak ada momen yang cocok dengan fokus; semua klip adalah momen terbaik lain dan diberi label “Di luar fokus”.";
  const match = typeof code === "string" ? /^([a-z_]+):([1-9]\d{0,5})$/.exec(code) : null;
  const label = match && Object.hasOwn(WARNING_LABELS, match[1]) ? WARNING_LABELS[match[1]] : null;
  return label ? label(match[2]) : null;
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

/**
 * Terms are the same term when this key is equal (case and accents do not count). The
 * lower-upper-lower round trip folds like Python's str.casefold() ("Straße" = "STRASSE",
 * "ﬁlm" = "FILM", final sigma), so terms the engine would reject as repeated are one term here.
 */
export function focusTermKey(value) {
  return normalizeFocusText(value).toLowerCase().toUpperCase().toLowerCase()
    .normalize("NFD").replace(/\p{M}+/gu, "").normalize("NFC");
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
 * chips; a duplicate is dropped; anything else stays in the input (`pending`) with `error`.
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
    if (length < FOCUS_LIMITS.termMin) problem = `Kata kunci “${term}” terlalu pendek (minimal ${FOCUS_LIMITS.termMin} karakter).`;
    else if (length > FOCUS_LIMITS.termMax) problem = `Kata kunci “${focusTermPreview(term)}” terlalu panjang (maksimal ${FOCUS_LIMITS.termMax} karakter).`;
    else if (keys.has(key)) {
      error ||= `“${term}” sudah ada.`;
      continue;
    } else if (next.length >= FOCUS_LIMITS.terms) problem = `Maksimal ${FOCUS_LIMITS.terms} kata kunci.`;
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
    return { ...committed, fields: null, error: `Catatan untuk AI maksimal ${FOCUS_LIMITS.note} karakter.` };
  }
  if (!committed.terms.length) {
    return cleanNote
      ? { ...committed, fields: null, error: "Isi minimal satu kata kunci fokus, atau kosongkan catatan untuk AI." }
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
 * "Fokus: jomok, jomokers — 5 dari 8 klip cocok" for a job with focus terms, or null (every job
 * without focus). The counts come from the engine's summary; without them only the terms.
 */
export function focusSummaryLine(job) {
  const terms = jobFocusTerms(job);
  if (!terms.length) return null;
  const summary = job?.selectionV3?.focus;
  const matched = focusCount(summary?.matched);
  const requested = focusCount(summary?.requested);
  const countText = matched !== null && requested !== null && requested > 0 && matched <= requested
    ? `${matched} dari ${requested} klip cocok`
    : null;
  const termsText = terms.join(", ");
  return { terms, termsText, countText, text: `Fokus: ${termsText}${countText ? ` — ${countText}` : ""}` };
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
  if (!match) return job?.selectionV3?.focus && typeof job.selectionV3.focus === "object" ? { tone: "none", label: "Di luar fokus" } : null;
  if (match === "none") return { tone: "none", label: "Di luar fokus" };
  const own = cleanFocusTerms(focus.terms);
  const terms = own.length ? own : jobFocusTerms(job);
  if (match === "semantic") {
    return { tone: "semantic", label: terms.length ? `Terkait ${quotedTerms(terms)} (menurut AI)` : "Terkait fokus (menurut AI)" };
  }
  const at = formatTimestamp(focus.at);
  const named = terms.length ? `Menyebut ${quotedTerms(terms)}` : "Menyebut fokus";
  return { tone: "literal", label: at ? `${named} · ${at}` : named };
}

export function coldOpenLength(clip) {
  const coldOpen = clip?.coldOpen;
  if (!coldOpen || typeof coldOpen.start !== "number" || typeof coldOpen.end !== "number") return null;
  const length = coldOpen.end - coldOpen.start;
  return Number.isFinite(length) && length > 0 ? length : null;
}

const TRANSCRIPT_SOURCE_TEXT = {
  "youtube-captions": "Transkrip dari subtitle YouTube",
  whisper: "Transkrip dari Whisper lokal",
};

function llmOutrankedByFocus(warnings) {
  return Array.isArray(warnings) && warnings.some((code) => typeof code === "string" && /^focus_llm_outranked:[1-9]\d{0,5}$/.test(code));
}

/** Plain-Indonesian presentation of a sanitized selectionV3 summary, or null. */
export function selectionV3SummaryView(summary) {
  if (!summary || summary.mode !== "v3") return null;
  const engine = [summary.provider, summary.model].filter(Boolean).join(" / ");
  let tone = "ok";
  let headline;
  let detail;
  if (summary.status === "failed") {
    tone = "error";
    headline = "Pemilihan momen V3 gagal";
    detail = "Engine tidak berhasil memilih momen. Lihat pesan kesalahan job di atas, lalu coba buat ulang.";
  } else if (summary.status === "fallback") {
    tone = "warning";
    headline = "Momen dipilih heuristik (cadangan)";
    detail = "LLM gagal atau tidak tersedia saat job berjalan, jadi pemilih heuristik lokal dipakai. Klip tetap dibuat, tetapi kualitas pemilihan bisa lebih rendah. Cek API key atau kuota penyedia LLM.";
  } else if (summary.source === "heuristic" && llmOutrankedByFocus(summary.warnings)) {
    // Fokus klip: the LLM answered, but every slot went to a moment that says a focus term.
    headline = "Semua slot diisi momen yang menyebut fokus";
    detail = "AI (LLM) sudah memberi usulan, tetapi setiap slot terisi momen yang menyebut kata kunci fokus di transkrip. Momen itu ditemukan pemilih heuristik lokal, jadi judul dan kemasannya juga dari heuristik.";
  } else if (summary.source === "llm") {
    headline = "Momen dipilih AI (LLM)";
    detail = engine ? `Dipilih dan diberi judul oleh ${engine}.` : "Dipilih dan diberi judul oleh LLM.";
  } else {
    headline = "Momen dipilih heuristik lokal";
    detail = "LLM tidak dipakai untuk job ini (dimatikan atau belum dikonfigurasi). Pemilih heuristik tanpa internet yang memilih momen.";
  }
  return {
    tone,
    headline,
    detail,
    engine: engine || null,
    transcript: TRANSCRIPT_SOURCE_TEXT[summary.transcript_source] || null,
    promptVersion: summary.prompt_version || null,
    warnings: Array.isArray(summary.warnings) ? summary.warnings : [],
  };
}

const LLM_STATE_TONES = { active: "ok", disabled: "muted", unconfigured: "muted", unusable: "warning", invalid: "warning" };

/**
 * The dashboard badge for /api/llm/status. `status` is that route's `llm`
 * object (or null while loading or when the route failed); `llmMode` is the
 * job option the operator picked.
 */
export function llmStatusView(status, llmMode = "auto") {
  if (llmMode === "off") {
    return { tone: "muted", label: "LLM tidak dipakai untuk job ini — memakai heuristik lokal" };
  }
  if (!status || typeof status !== "object" || typeof status.label !== "string" || !status.label) {
    return { tone: "muted", label: "Memeriksa status LLM…" };
  }
  return { tone: LLM_STATE_TONES[status.state] || "warning", label: status.label };
}
