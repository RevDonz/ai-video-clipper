// The camera analysis progress of a clip (plan §11.3 T3.6, §5.7). While `prepare` builds a camera
// plan, `edit_v2.camera.ProgressFile` keeps `preview/camera.progress.json` in the clip directory:
// `{schema: "potongin.camera-progress/1", window_ms, done, total}` (samples analysed so far),
// replaced atomically and removed when the plan is written. The layout panel polls it through
// `GET /api/jobs/:id/clips/:clipId/camera-progress` (`cameraProgressResponse`) and shows a
// percentage; anything else reads as `{state: "none"}` and the panel shows the elapsed seconds.
import { requireAuth as defaultRequireAuth } from "./auth.mjs";
import { CLIP_ID, JOB_ID, openClipFile } from "./clip-media.mjs";

export const CAMERA_PROGRESS_FILE = Object.freeze({ dir: "preview", pattern: /^camera\.progress\.json$/, type: "application/json" });
export const PROGRESS_SCHEMA = "potongin.camera-progress/1";
export const MAX_PROGRESS_BYTES = 4096;
// A file this old belongs to a prepare that died before removing it (it is rewritten every
// sample or at least every few seconds while one runs).
export const STALE_AFTER_MS = 30_000;
const NONE = Object.freeze({ state: "none" });

function valid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schema !== PROGRESS_SCHEMA) return false;
  const { done, total, window_ms: window } = value;
  return Number.isSafeInteger(done) && Number.isSafeInteger(total) && total >= 1 && done >= 0 && done <= total
    && Array.isArray(window) && window.length === 2 && window.every(Number.isSafeInteger);
}

/** `{state: "building", done, total}` while a camera plan is analysed, else `{state: "none"}`. */
export async function readCameraProgress({ jobsRoot, jobId, clipId, now = Date.now } = {}) {
  if (!jobsRoot || !JOB_ID.test(jobId || "") || !CLIP_ID.test(clipId || "")) return NONE;
  let opened;
  try {
    opened = await openClipFile(jobsRoot, jobId, clipId, CAMERA_PROGRESS_FILE, "camera.progress.json");
  } catch {
    return NONE;
  }
  try {
    if (opened.size > MAX_PROGRESS_BYTES) return NONE;
    const info = await opened.handle.stat();
    if (now() - info.mtimeMs > STALE_AFTER_MS) return NONE;
    const value = JSON.parse(await opened.handle.readFile({ encoding: "utf8" }));
    return valid(value) ? { state: "building", done: value.done, total: value.total } : NONE;
  } catch {
    return NONE;
  } finally {
    await opened.handle.close().catch(() => {});
  }
}

const json = (status, body) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

/** `GET /api/jobs/:id/clips/:clipId/camera-progress`: 404 while the editor is off, 401, 400. */
export async function cameraProgressResponse(request, params, { env = process.env, requireAuth = defaultRequireAuth } = {}) {
  if (env.POTONGIN_EDITOR_V3 !== "on") return json(404, { error: { code: "not_found", messageId: "edit.not_found" } });
  const denied = requireAuth(request);
  if (denied) return denied;
  if (!JOB_ID.test(params?.id || "") || !CLIP_ID.test(params?.clipId || "")) {
    return json(400, { error: { code: "invalid_request", messageId: "edit.invalid_request" } });
  }
  return json(200, await readCameraProgress({ jobsRoot: env.JOBS_ROOT, jobId: params.id, clipId: params.clipId }));
}
