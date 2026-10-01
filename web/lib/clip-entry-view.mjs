// The project page's editor entry per clip (plan §11.2 T2.6): the "Edit klip" link, the edit
// badge, the latest export link and the reason a clip cannot open, from `GET /api/jobs/:id/clips`
// (plan §4.2). That route only answers when POTONGIN_EDITOR_V3=on, so a 404 simply hides the
// entry. A clip that still needs preparing links to the editor as well: the editor prepares the
// job on open and shows the progress (W3, owner feedback; lib/editor/open-clip.mjs). The history's
// "Edit klip" rule lives here too. Client-safe: no Node built-ins.

export const CLIP_REASON_TEXT = Object.freeze({
  needs_prepare: "Klip perlu disiapkan dulu",
  source_missing: "Video sumber sudah tidak ada",
  source_unreadable: "Video sumber tidak bisa dibaca; proses ulang videonya",
  selection_unreadable: "Hasil seleksi tidak terbaca",
  transcript_missing: "Transkrip tidak ditemukan",
  analysis_incomplete: "Analisis job belum selesai",
  not_v3: "Klip dari job ini tidak bisa diedit; proses ulang videonya",
});

const GENERIC_REASON = "Klip ini belum bisa dibuka di editor";
const CLIP_ID = /^clip_[0-9a-f]{24}$/;
const IN_PROGRESS = new Set(["queued", "claimed", "rendering"]);
// Reasons the editor resolves by itself when the clip is opened (it prepares the job).
const PREPARED_ON_OPEN = new Set(["needs_prepare", "analysis_incomplete"]);

function editorPath(jobId, { clipId, index }) {
  const job = encodeURIComponent(jobId);
  if (clipId) return `/projects/${job}/clips/${encodeURIComponent(clipId)}/edit`;
  return Number.isInteger(index) && index >= 1 && index <= 99 ? `/projects/${job}/clips/klip-${index}/edit` : null;
}

// Only the job's own API files, as the server builds them: no scheme, host, dot segments,
// backslashes or control characters.
function ownUrl(jobId, value) {
  if (typeof value !== "string") return null;
  const prefix = `/api/jobs/${jobId}/`;
  if (!value.startsWith(prefix) || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const segments = value.slice(prefix.length).split("?")[0].split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || /%2e|%2f/i.test(segment))) return null;
  return value;
}

/**
 * An edited export is stored under a hash name; its link asks the file route to save it as
 * "klip-NN-revisi-R" plus the file's own extension: `{href, filename}` (filename null when the
 * clip number or revision is unknown), or null without a link.
 */
export function exportDownload(href, { index, revision } = {}) {
  if (typeof href !== "string" || !href) return null;
  const known = Number.isInteger(index) && index >= 1 && index <= 99 && Number.isInteger(revision) && revision >= 0;
  const extension = /\.[a-z0-9]+$/i.exec(href.split("?")[0])?.[0].toLowerCase() ?? "";
  if (!known || !extension) return { href, filename: null };
  const name = `klip-${String(index).padStart(2, "0")}-revisi-${revision}`;
  return { href: `${href}${href.includes("?") ? "&" : "?"}download=1&name=${name}`, filename: `${name}${extension}` };
}

function latestExportView(jobId, render, index) {
  if (!render || typeof render !== "object") return null;
  if (render.state === "completed") {
    const ref = { index, revision: render.revision };
    const mp4 = exportDownload(ownUrl(jobId, render.url), ref);
    const srt = exportDownload(ownUrl(jobId, render.srtUrl), ref);
    return { label: `Ekspor terakhir · revisi ${render.revision}`, state: "completed",
      href: mp4?.href ?? null, filename: mp4?.filename ?? null, srtHref: srt?.href ?? null, srtFilename: srt?.filename ?? null };
  }
  if (IN_PROGRESS.has(render.state)) return { label: "Ekspor sedang diproses", state: render.state, href: null, srtHref: null };
  if (render.state === "failed") return { label: "Ekspor terakhir gagal", state: "failed", href: null, srtHref: null };
  return null;
}

function editBadge(edit) {
  if (!edit || typeof edit !== "object") return null;
  if (edit.state === "edited") return { text: `Diedit · revisi ${edit.revision}`, tone: "edited" };
  if (edit.state === "seed") return { text: "Belum diedit", tone: "muted" };
  return null;
}

/** The entry of one clip from the listing (plan §4.2 `GET /clips`). */
export function clipEntryView(jobId, clip) {
  const clipId = typeof clip?.clipId === "string" && CLIP_ID.test(clip.clipId) ? clip.clipId : null;
  const malformed = clip?.clipId !== null && clip?.clipId !== undefined && !clipId;
  const openable = clip?.openable === true && Boolean(clipId);
  const reason = typeof clip?.reason === "string" ? clip.reason : null;
  const preparedOnOpen = !openable && !malformed && PREPARED_ON_OPEN.has(reason);
  const editHref = openable || preparedOnOpen ? editorPath(jobId, { clipId, index: clip?.index }) : null;
  return {
    index: clip?.index,
    clipId,
    openable,
    editHref,
    reasonText: openable || editHref ? null : (!malformed && CLIP_REASON_TEXT[reason]) || GENERIC_REASON,
    needsPrepare: !openable && reason === "needs_prepare",
    editBadge: editBadge(clip?.edit),
    latestExport: latestExportView(jobId, clip?.latestRender, clip?.index),
  };
}

/**
 * A clip's entry on the project page: the listing's own, or, when the listing loaded without it
 * (a job made before the editor: no manifest or no analysis), the reason it cannot open. Null
 * while the listing is off, loading or failed: the card then shows no editor entry at all.
 */
export function clipEntryFor(listing, job, index) {
  const listed = listing?.byIndex?.get(index);
  if (listed) return listed;
  if (listing?.state !== "available") return null;
  const reason = job?.options?.selectionMode === "v3" ? null : "not_v3";
  return clipEntryView(job?.id, { index, clipId: null, openable: false, reason });
}

/**
 * Whether the history links a project to its clips for editing: the editor is on, the project
 * finished with clips, and it ran the current selection (older jobs have no clip to edit).
 */
export function historyOffersEdit(job, editor) {
  return editor === true && job?.status === "completed" && Array.isArray(job?.clips) && job.clips.length > 0
    && job?.options?.selectionMode === "v3";
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Loads the listing. `available` with the entries by clip index; `unavailable` when the route is
 * off (404: POTONGIN_EDITOR_V3 is not on); `redirect` on 401; `error` otherwise.
 */
export async function loadClipEntries(jobId, { fetchImpl = fetch, signal } = {}) {
  let response;
  try {
    response = await fetchImpl(`/api/jobs/${jobId}/clips`, { cache: "no-store", signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    return { state: "error", byIndex: new Map(), message: "Status editor klip tidak dapat dimuat karena gangguan jaringan." };
  }
  if (response.status === 401) {
    return { state: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${jobId}`)}`, byIndex: new Map() };
  }
  if (response.status === 404) return { state: "unavailable", byIndex: new Map() };
  const payload = await readJson(response);
  if (!response.ok || !Array.isArray(payload?.clips)) {
    return { state: "error", byIndex: new Map(), message: "Status editor klip tidak dapat dimuat." };
  }
  const byIndex = new Map();
  for (const clip of payload.clips) {
    if (Number.isInteger(clip?.index)) byIndex.set(clip.index, clipEntryView(jobId, clip));
  }
  return { state: "available", byIndex };
}
