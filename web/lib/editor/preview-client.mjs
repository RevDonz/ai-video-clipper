// Preview requests (plan §2.5 "Edit", §4.2 `preview/plan` and `preview/frame`, Appendix A.2).
//
// `plan(doc)` is debounced (120 ms) and latest-wins: a call replaced before it is sent, or whose
// request is still running when a newer one is sent, rejects with an `AbortError` (code
// "superseded") and its fetch is aborted; callers ignore those. Each request tells the server
// the ASS it already has (`known.assSha256`); when the answer omits `text.ass` because it is
// unchanged, the cached bytes are put back, so a resolved plan always carries `text.ass`.
// A 429 is retried after `Retry-After` (at most 2 s, three times); a 422 rejects with a
// `PreviewError` of code "invalid" and the validator's issues (a client bug by contract).

export const PREVIEW_DEBOUNCE_MS = 120;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIP_ID = /^clip_[0-9a-f]{24}$/;

export class PreviewError extends Error {
  constructor(code, status = 0, errors = []) {
    super(`preview ${status} ${code}`);
    this.name = "PreviewError";
    this.code = code;
    this.status = status;
    this.errors = errors;
  }
}

function superseded() {
  const error = new Error("superseded");
  error.name = "AbortError";
  error.code = "superseded";
  return error;
}

function serverCode(data, status) {
  if (typeof data?.code === "string") return data.code;
  if (typeof data?.error?.code === "string") return data.error.code;
  return `http_${status}`;
}

export function createPreviewClient({ jobId, clipId, fetchImpl = globalThis.fetch?.bind(globalThis), debounceMs = PREVIEW_DEBOUNCE_MS,
  base = "", setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), maxRetryMs = 2000 }) {
  if (typeof jobId !== "string" || !UUID.test(jobId)) throw new TypeError("jobId is invalid");
  if (typeof clipId !== "string" || !CLIP_ID.test(clipId)) throw new TypeError("clipId is invalid");
  const clipRoot = `${base}/api/jobs/${jobId}/clips/${clipId}`;
  let waiting = null;
  let timer = null;
  let inflight = null;
  let frameInflight = null;
  let cache = null;

  const post = (url, body, signal) => fetchImpl(url, {
    method: "POST", credentials: "same-origin", cache: "no-store", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body),
  });

  const delay = (ms, signal) => new Promise((resolve) => {
    const id = setTimer(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimer(id);
      resolve();
    }, { once: true });
  });

  async function attempt(doc, signal) {
    for (let tries = 0; ; tries += 1) {
      let response;
      try {
        response = await post(`${clipRoot}/preview/plan`, { doc, known: cache ? { assSha256: cache.sha } : {} }, signal);
      } catch (error) {
        if (error?.name === "AbortError" || signal.aborted) throw superseded();
        throw new PreviewError("network_error", 0);
      }
      if (response.status === 429 && tries < 3) {
        const seconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
        await delay(Number.isFinite(seconds) ? Math.min(maxRetryMs, Math.max(100, seconds * 1000)) : 250, signal);
        if (signal.aborted) throw superseded();
        continue;
      }
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (signal.aborted) throw superseded();
      if (response.status === 422) throw new PreviewError("invalid", 422, Array.isArray(data?.errors) ? data.errors : []);
      if (!response.ok || !data || typeof data !== "object") throw new PreviewError(serverCode(data, response.status), response.status);
      if (data.text && typeof data.text === "object") {
        if (typeof data.text.ass === "string") cache = { sha: data.text.assSha256, ass: data.text.ass };
        else if (cache && data.text.assSha256 === cache.sha) data.text = { ...data.text, ass: cache.ass };
      }
      return data;
    }
  }

  async function send() {
    timer = null;
    const call = waiting;
    waiting = null;
    if (!call) return;
    inflight?.controller.abort();
    const current = { controller: new AbortController() };
    inflight = current;
    try {
      call.resolve(await attempt(call.doc, current.controller.signal));
    } catch (error) {
      call.reject(error);
    } finally {
      if (inflight === current) inflight = null;
    }
  }

  return {
    /** The plan DTO (§4.3) of an unsaved document; latest wins. */
    plan(doc) {
      return new Promise((resolve, reject) => {
        waiting?.reject(superseded());
        waiting = { doc, resolve, reject };
        if (timer !== null) clearTimer(timer);
        timer = setTimer(send, debounceMs);
      });
    },
    /** A truth frame (PNG) of frame `f`; a newer request aborts the previous one. */
    async frame(doc, f) {
      if (!Number.isSafeInteger(f) || f < 0) throw new TypeError("frame must be a non-negative integer");
      frameInflight?.abort();
      const controller = new AbortController();
      frameInflight = controller;
      let response;
      try {
        response = await post(`${clipRoot}/preview/frame`, { doc, f }, controller.signal);
      } catch (error) {
        if (error?.name === "AbortError" || controller.signal.aborted) throw superseded();
        throw new PreviewError("network_error", 0);
      } finally {
        if (frameInflight === controller) frameInflight = null;
      }
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        if (response.status === 422) throw new PreviewError("invalid", 422, Array.isArray(data?.errors) ? data.errors : []);
        throw new PreviewError(serverCode(data, response.status), response.status);
      }
      return response.blob();
    },
    /** Cancels everything pending (the editor is closing). */
    destroy() {
      if (timer !== null) clearTimer(timer);
      timer = null;
      waiting?.reject(superseded());
      waiting = null;
      inflight?.controller.abort();
      frameInflight?.abort();
    },
  };
}
