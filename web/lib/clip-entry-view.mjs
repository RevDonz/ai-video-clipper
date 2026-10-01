// The project page's Editor V3 entry per V3 clip (plan §11.2 T2.6): the "Edit klip" link, the edit
// badge, the latest export link and the openable/reason message, from `GET /api/jobs/:id/clips`
// (plan §4.2). That route only answers when POTONGIN_EDITOR_V3=on, so a 404 simply hides the
// entry. Client-safe: no Node built-ins.

export const CLIP_REASON_TEXT = Object.freeze({
  needs_prepare: "Klip perlu disiapkan dulu",
  source_missing: "Video sumber sudah tidak ada",
  selection_unreadable: "Hasil seleksi tidak terbaca",
  transcript_missing: "Transkrip tidak ditemukan",
  analysis_incomplete: "Analisis job belum selesai",
  not_v3: "Klip dari job ini tidak bisa diedit; proses ulang videonya",
});

const GENERIC_REASON = "Klip ini belum bisa dibuka di editor";
const CLIP_ID = /^clip_[0-9a-f]{24}$/;
const IN_PROGRESS = new Set(["queued", "claimed", "rendering"]);

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

function latestExportView(jobId, render) {
  if (!render || typeof render !== "object") return null;
  if (render.state === "completed") {
    return { label: `Ekspor terakhir · revisi ${render.revision}`, state: "completed",
      href: ownUrl(jobId, render.url), srtHref: ownUrl(jobId, render.srtUrl) };
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
  return {
    index: clip?.index,
    clipId,
    openable,
    editHref: openable ? `/projects/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(clipId)}/edit` : null,
    reasonText: openable ? null : (!malformed && CLIP_REASON_TEXT[reason]) || GENERIC_REASON,
    needsPrepare: !openable && reason === "needs_prepare",
    editBadge: editBadge(clip?.edit),
    latestExport: latestExportView(jobId, clip?.latestRender),
    engineLegacy: clip?.engine === "legacy",
  };
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

/** Job-level prepare for jobs rendered before Essentials (plan §4.2 `POST /clips`). */
export async function prepareClipEntries(jobId, { fetchImpl = fetch } = {}) {
  const failure = { ok: false, message: "Klip belum bisa disiapkan. Coba lagi sebentar lagi." };
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}/clips`, {
      method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    return response.ok ? { ok: true, message: "" } : failure;
  } catch {
    return failure;
  }
}
