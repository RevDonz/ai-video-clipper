// "Hook di video" on the project page (CONTRACTS §5.57): one switch per clip that shows or hides
// the hook text in the video. The switch saves the clip's editor document (POST …/hook, which
// writes the same change as the editor's SetHookEnabled) and then exports that revision (POST
// …/renders), so the editor and the file agree. Switching back to the seed's look exports the
// automatic file at once. Client-safe: no Node built-ins.
import { randomUuid } from "./editor/api-client.mjs";

export const HOOK_COPY = Object.freeze({
  label: "Hook di video",
  hint: "Mengubahnya mengekspor ulang klip. Hasilnya di Ekspor terakhir.",
  saving: "Menyimpan…",
  onExporting: "Hook tampil. Klip sedang diekspor ulang.",
  offExporting: "Hook disembunyikan. Klip sedang diekspor ulang.",
  onReady: "Hook tampil di video.",
  offReady: "Hook disembunyikan dari video.",
  conflict: "Klip ini sudah diubah di editor. Coba lagi.",
  failed: "Hook belum tersimpan. Coba lagi.",
  exportFailed: "Tersimpan, tapi ekspor belum jalan. Ekspor dari editor.",
});

const CLIP_ID = /^clip_[0-9a-f]{24}$/;
const ETAG = /^[0-9a-f]{64}$/;
const RUNNING = new Set(["queued", "claimed", "rendering"]);

/**
 * The switch of one clip, or null when it does not show: `{on, clipId, etag}` for a finished
 * project's clip (`editable`) that the editor can open, has a hook to show (its own or its
 * seed's) and is not read-only.
 */
export function hookSwitchView(entry, { editable }) {
  if (!editable || !entry?.openable || !CLIP_ID.test(entry.clipId ?? "") || !ETAG.test(entry.editEtag ?? "")) return null;
  if (entry.hook?.available !== true || typeof entry.hook.on !== "boolean") return null;
  return { on: entry.hook.on, clipId: entry.clipId, etag: entry.editEtag };
}

function loginRedirect(jobId) {
  return { type: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${jobId}`)}` };
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function post(fetchImpl, url, body, key) {
  return fetchImpl(url, {
    method: "POST", cache: "no-store", body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
  });
}

function savedHook(body) {
  const hook = body?.hook;
  if (!ETAG.test(body?.etag ?? "") || typeof body?.changed !== "boolean" || typeof hook?.on !== "boolean"
    || typeof hook?.available !== "boolean") return null;
  return { etag: body.etag, changed: body.changed, hook: { on: hook.on, available: hook.available } };
}

/**
 * Switch the hook of a clip at `etag` on or off, then export the new revision.
 * `{type: "done", hook, etag, exporting, message, warning?}` (`warning` when the save worked but
 * the export did not start), `{type: "error", code, message}` or `{type: "redirect", location}`.
 */
export async function switchHook({ jobId, clipId, etag, on }, { fetchImpl = fetch, uuid = randomUuid } = {}) {
  const root = `/api/jobs/${encodeURIComponent(jobId)}/clips/${encodeURIComponent(clipId)}`;
  let response;
  try {
    response = await post(fetchImpl, `${root}/hook`, { on, etag }, uuid());
  } catch {
    return { type: "error", code: null, message: HOOK_COPY.failed };
  }
  if (response.status === 401) return loginRedirect(jobId);
  const body = await readJson(response);
  const saved = response.ok ? savedHook(body) : null;
  if (!saved) {
    const code = typeof body?.code === "string" ? body.code : null;
    return { type: "error", code, message: code === "revision_conflict" ? HOOK_COPY.conflict : HOOK_COPY.failed };
  }
  const ready = saved.hook.on ? HOOK_COPY.onReady : HOOK_COPY.offReady;
  const done = { type: "done", hook: saved.hook, etag: saved.etag };
  if (!saved.changed) return { ...done, exporting: false, message: ready };
  let render;
  try {
    render = await post(fetchImpl, `${root}/renders`, { editEtag: saved.etag }, uuid());
  } catch {
    return { ...done, exporting: false, message: HOOK_COPY.exportFailed, warning: true };
  }
  if (render.status === 401) return loginRedirect(jobId);
  const state = render.ok ? (await readJson(render))?.state : null;
  if (RUNNING.has(state)) {
    return { ...done, exporting: true, message: saved.hook.on ? HOOK_COPY.onExporting : HOOK_COPY.offExporting };
  }
  if (state === "completed") return { ...done, exporting: false, message: ready };
  return { ...done, exporting: false, message: HOOK_COPY.exportFailed, warning: true };
}
