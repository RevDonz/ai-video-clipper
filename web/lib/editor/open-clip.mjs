// Opening a clip in the editor with no manual prepare step (owner feedback, W3). "Edit klip" links
// to /projects/<job>/clips/<ref>/edit, where <ref> is the clip id or, for a clip of an older job
// that has no id yet, "klip-<n>" (its number on the project page). The editor then prepares the
// job by itself (POST /api/jobs/:id/clips, plan §4.2: words, waveform and camera plans for every
// clip of the job) and shows the progress, so the owner never has to find a "Siapkan" button.
// Client-safe: no Node built-ins.

import { CLIP_REASON_TEXT } from "../clip-entry-view.mjs";

export const CLIP_REF_PREFIX = "klip-";
const CLIP_ID = /^clip_[0-9a-f]{24}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i; // as the page gate (shell-model.mjs)
const INDEX_REF = /^klip-([1-9][0-9]?)$/;
// The listing says these clips open once the job is prepared (or while it is being prepared).
const PREPARABLE = new Set(["needs_prepare", "analysis_incomplete"]);

const TEXT = Object.freeze({
  not_found: "Klip ini tidak ada di proyek ini",
  editor_disabled: "Editor belum diaktifkan",
  network: "Server tidak terjangkau. Periksa koneksi, lalu muat ulang halaman.",
  listing: "Daftar klip tidak bisa dimuat. Muat ulang halaman.",
  prepare_failed: "Klip belum bisa disiapkan. Coba lagi sebentar lagi.",
  prepare_timeout: "Menyiapkan klip terlalu lama. Muat ulang halaman untuk mencoba lagi.",
});

/** `{clipId, index}` from the URL segment, or null when it is neither a clip id nor klip-<n>. */
export function clipRefFromSegment(segment) {
  if (typeof segment !== "string") return null;
  if (CLIP_ID.test(segment)) return { clipId: segment, index: null };
  const match = INDEX_REF.exec(segment);
  return match ? { clipId: null, index: Number(match[1]) } : null;
}

/** The editor URL of a clip by id (preferred) or by its number; null for anything malformed. */
export function editorHref(jobId, { clipId = null, index = null } = {}) {
  if (typeof jobId !== "string" || !JOB_ID.test(jobId)) return null;
  if (typeof clipId === "string" && CLIP_ID.test(clipId)) return `/projects/${jobId}/clips/${clipId}/edit`;
  if (Number.isInteger(index) && index >= 1 && index <= 99) return `/projects/${jobId}/clips/${CLIP_REF_PREFIX}${index}/edit`;
  return null;
}

const failure = (code, message = TEXT[code]) => ({ state: "error", code, message });

async function listing(jobId, fetchImpl, signal) {
  let response;
  try {
    response = await fetchImpl(`/api/jobs/${jobId}/clips`, { cache: "no-store", signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { failure: failure("network") };
  }
  if (response.status === 401) return { redirect: true };
  if (response.status === 404) return { failure: failure("editor_disabled") };
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok || !Array.isArray(body?.clips)) return { failure: failure("listing") };
  return { clips: body.clips };
}

function find(clips, { clipId, index }) {
  if (clipId) return clips.find((clip) => clip?.clipId === clipId) ?? null;
  return clips.find((clip) => clip?.index === index) ?? null;
}

/** The error for clip number `index` when a finished prepare left it closed, else null. */
function finishedClosed(answer, index) {
  if (answer?.state !== "done" || !Array.isArray(answer.clips) || !Number.isInteger(index)) return null;
  const clip = answer.clips.find((entry) => entry?.index === index);
  if (!clip || clip.openable === true) return null;
  const known = typeof clip.reason === "string" && clip.reason !== "needs_prepare" && Object.hasOwn(CLIP_REASON_TEXT, clip.reason);
  return known ? failure(clip.reason, CLIP_REASON_TEXT[clip.reason]) : failure("prepare_failed");
}

function retryAfterMs(response, fallback) {
  const seconds = Number(response.headers?.get?.("retry-after"));
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1000 : fallback;
}

/**
 * Makes the clip openable: `{state: "ready", clipId, prepared}` (prepared: the job was prepared
 * here), `{state: "redirect", location}` when the session is gone, or `{state: "error", code,
 * message}`. `onProgress({phase})` reports "preparing" (the job-level prepare runs) and
 * "checking" (the listing is read again).
 */
export async function prepareForEditor({
  jobId, clipId = null, index = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  onProgress = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
  pollMs = 2000,
  maxWaitMs = 12 * 60_000,
  signal,
} = {}) {
  const ref = { clipId, index };
  const here = editorHref(jobId, ref) ?? `/projects/${jobId}`;
  const read = async () => {
    const result = await listing(jobId, fetchImpl, signal);
    if (result.redirect) return { done: { state: "redirect", location: `/login?next=${encodeURIComponent(here)}` } };
    if (result.failure) return { done: result.failure };
    const clip = find(result.clips, ref);
    if (!clip) return { done: failure("not_found") };
    if (clip.openable === true && CLIP_ID.test(clip.clipId ?? "")) return { clip, openable: true };
    if (!PREPARABLE.has(clip.reason)) {
      const code = typeof clip.reason === "string" && Object.hasOwn(CLIP_REASON_TEXT, clip.reason) ? clip.reason : "not_openable";
      return { done: failure(code, CLIP_REASON_TEXT[code] ?? "Klip ini belum bisa dibuka di editor") };
    }
    return { clip, openable: false };
  };

  const first = await read();
  if (first.done) return first.done;
  if (first.openable) return { state: "ready", clipId: first.clip.clipId, prepared: false };

  const started = now();
  onProgress({ phase: "preparing" });
  let response;
  try {
    response = await fetchImpl(`/api/jobs/${jobId}/clips`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}", signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return failure("network");
  }
  // Read the answer to the end, so a later abort of `signal` never cuts off its body.
  let answer = null;
  try { answer = JSON.parse(new TextDecoder().decode(await response.arrayBuffer())); } catch { answer = null; }
  if (response.status === 401) return { state: "redirect", location: `/login?next=${encodeURIComponent(here)}` };
  // 429: this job's prepare already runs (another tab) or ran just now; wait and read the listing.
  if (response.status === 429) await sleep(retryAfterMs(response, pollMs));
  else if (!response.ok) return failure("prepare_failed");
  else {
    // A finished prepare names every clip it could not open (a source FFmpeg cannot read, …);
    // the listing never decodes, so it would keep saying "needs_prepare".
    const closed = finishedClosed(answer, first.clip.index ?? index);
    if (closed) return closed;
  }

  for (;;) {
    onProgress({ phase: "checking" });
    const next = await read();
    if (next.done) return next.done;
    if (next.openable) return { state: "ready", clipId: next.clip.clipId, prepared: true };
    if (now() - started >= maxWaitMs) return failure("prepare_timeout");
    await sleep(pollMs);
  }
}
