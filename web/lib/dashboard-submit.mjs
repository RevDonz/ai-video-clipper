// Sending Buat klip's form (POST /api/jobs, multipart, unchanged fields) with the upload's
// progress, which fetch() does not report: XMLHttpRequest. Client-safe; the request class is
// passed in so tests use a stand-in.

/** The phase the submit button names: "uploading" (a file, with a percent), "checking", "preparing". */
export function submitPhase({ sending, upload, uploaded }) {
  if (!sending) return null;
  if (!upload) return "preparing";
  return uploaded ? "checking" : "uploading";
}

/** Whole percent of an upload progress event, or null when the size is unknown. */
export function uploadPercent(event) {
  if (!event?.lengthComputable || !(event.total > 0)) return null;
  return Math.max(0, Math.min(100, Math.floor((event.loaded / event.total) * 100)));
}

/**
 * POST `body` to /api/jobs. Resolves `{status, payload}` (payload {} when the answer is not
 * JSON); rejects with a TypeError when the request did not reach the server.
 * `onProgress(percent | null)` during the upload, `onUploaded()` once the body is sent.
 */
export function sendJob(body, { onProgress, onUploaded, Request = globalThis.XMLHttpRequest } = {}) {
  return new Promise((resolve, reject) => {
    const request = new Request();
    request.open("POST", "/api/jobs");
    request.responseType = "text";
    request.upload?.addEventListener?.("progress", (event) => onProgress?.(uploadPercent(event)));
    request.upload?.addEventListener?.("load", () => onUploaded?.());
    request.addEventListener("load", () => {
      let payload = {};
      try {
        const parsed = JSON.parse(request.responseText || "null");
        if (parsed && typeof parsed === "object") payload = parsed;
      } catch {
        // Not JSON: the page shows its own text.
      }
      resolve({ status: request.status, payload });
    });
    request.addEventListener("error", () => reject(new TypeError("network")));
    request.addEventListener("abort", () => reject(new TypeError("aborted")));
    request.send(body);
  });
}

const JOB_ID = /^[0-9a-f-]{8,64}$/i;
const projectHref = (id) => (typeof id === "string" && JOB_ID.test(id) ? `/projects/${encodeURIComponent(id)}` : null);

/** Where the page goes after a job POST answered: the new job's project, or null on a refusal. */
export function projectAfterSubmit({ status, payload }) {
  return status >= 200 && status < 300 ? projectHref(payload?.job?.id) : null;
}

/** A refused POST that still made a job (it failed right away): that project's page, or null. */
export function failedJobHref({ status, payload }) {
  return status >= 200 && status < 300 ? null : projectHref(payload?.jobId);
}
