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
