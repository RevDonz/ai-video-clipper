// Browser client of the Editor V3 routes (plan §4.2, Appendix A.2 `createApiClient`).
//
// Every request is same-origin with credentials and `cache: "no-store"`. Ids are checked before a
// URL is built (never user text in a path). A non-2xx answer or a network failure becomes an
// `ApiError { status, code, body }`: `code` is the server's fixed code (`{code}` or
// `{error: {code}}`), `status` 0 means the network failed. A 409 revision conflict carries
// `body.current` and `body.etag` (from the body or the `ETag` header), which the store rebases on.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLIP_ID = /^clip_[0-9a-f]{24}$/;
const ETAG = /^[0-9a-f]{64}$/;

/**
 * A random UUID v4 for Idempotency-Keys: `crypto.randomUUID` where the page is a secure context,
 * otherwise built from `crypto.getRandomValues` (available everywhere), so saving never depends
 * on how the app is reached.
 */
export function randomUuid(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === "function") return cryptoImpl.randomUUID();
  const bytes = new Uint8Array(16);
  cryptoImpl.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ApiError extends Error {
  constructor(status, code, body = {}) {
    super(`editor api ${status} ${code}`);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.body = body ?? {};
  }
}

function check(pattern, value, name) {
  if (typeof value !== "string" || !pattern.test(value)) throw new TypeError(`${name} is invalid`);
  return value;
}

function etagHeader(response) {
  const value = response.headers.get("etag");
  const match = value ? /^(?:W\/)?"?([0-9a-f]{64})"?$/.exec(value.trim()) : null;
  return match ? match[1] : null;
}

function errorCode(status, body) {
  if (typeof body?.code === "string") return body.code;
  if (typeof body?.error?.code === "string") return body.error.code;
  return `http_${status}`;
}

export function createApiClient({ jobId, clipId, fetchImpl = globalThis.fetch?.bind(globalThis), base = "" }) {
  check(UUID, jobId, "jobId");
  check(CLIP_ID, clipId, "clipId");
  const jobRoot = `${base}/api/jobs/${jobId}`;
  const clipRoot = `${jobRoot}/clips/${clipId}`;

  async function request(method, url, { body, headers = {}, raw = false } = {}) {
    const init = { method, credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json", ...headers } };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      init.headers["Content-Type"] = "application/json";
    }
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      throw new ApiError(0, "network_error", {});
    }
    if (raw && response.ok) return response;
    const type = response.headers.get("content-type") ?? "";
    let data = null;
    if (type.includes("json")) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    }
    if (!response.ok) {
      const errorBody = data && typeof data === "object" ? { ...data } : {};
      if (response.status === 409 && errorBody.etag === undefined) {
        const etag = etagHeader(response);
        if (etag) errorBody.etag = etag;
      }
      throw new ApiError(response.status, errorCode(response.status, errorBody), errorBody);
    }
    if (data && typeof data === "object" && !Array.isArray(data) && data.etag === undefined) {
      const etag = etagHeader(response);
      if (etag) data.etag = etag;
    }
    return data;
  }

  return {
    async clips() {
      return request("GET", `${jobRoot}/clips`);
    },
    /** The current document (or the seed as virtual revision 0); `{ seed: true }` always the seed. */
    async getEdit({ seed = false } = {}) {
      return request("GET", `${clipRoot}/edit${seed ? "?seed=1" : ""}`);
    },
    /** Saves the full document: `If-Match` = the etag it is based on, one key per payload. */
    async putEdit(doc, { etag, key }) {
      check(ETAG, etag, "etag");
      check(UUID, key, "idempotency key");
      return request("PUT", `${clipRoot}/edit`, { body: doc, headers: { "If-Match": `"${etag}"`, "Idempotency-Key": key } });
    },
    async words(url) {
      if (typeof url !== "string" || !url.startsWith(`/api/jobs/${jobId}/`) || url.includes("..")) throw new TypeError("words url is invalid");
      return request("GET", `${base}${url}`);
    },
    async prepare({ layout } = {}) {
      return request("POST", `${clipRoot}/prepare`, { body: layout === undefined ? {} : { layout } });
    },
    async createRender({ editEtag }, key) {
      check(ETAG, editEtag, "editEtag");
      check(UUID, key, "idempotency key");
      return request("POST", `${clipRoot}/renders`, { body: JSON.stringify({ editEtag }), headers: { "Idempotency-Key": key } });
    },
    async getRender(renderId) {
      check(UUID, renderId, "renderId");
      return request("GET", `${jobRoot}/renders/${renderId}`);
    },
    async cancelRender(renderId) {
      check(UUID, renderId, "renderId");
      return request("DELETE", `${jobRoot}/renders/${renderId}`);
    },
    async cleanup() {
      return request("GET", `${clipRoot}/cleanup`);
    },
    async coldOpenSuggestions() {
      return request("GET", `${clipRoot}/coldopen-suggestions`);
    },
    async aiHooks(doc) {
      return request("POST", `${clipRoot}/ai`, { body: { task: "hooks", doc } });
    },
    async aiTask(taskId) {
      check(UUID, taskId, "taskId");
      return request("GET", `${clipRoot}/ai/${taskId}`);
    },
  };
}
