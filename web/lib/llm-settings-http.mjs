// Request/response helpers shared by the /api/settings/llm routes.

import { sameOriginMutation } from "./request-security.mjs";
import { LlmSettingsError, settingsErrorStatus } from "./llm-settings.mjs";

export const MAX_SETTINGS_BODY_BYTES = 128 * 1024;
export const MAX_ACTION_BODY_BYTES = 1024;

export class HttpBodyError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "HttpBodyError";
    this.status = status;
  }
}

export function noStore(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** Auth first (401), then, for mutations, the same-origin check (403). */
export function guardRequest(request, { authorize, sameOrigin = sameOriginMutation, mutation = false }) {
  const denied = authorize(request);
  if (denied) {
    denied.headers.set("Cache-Control", "no-store");
    return denied;
  }
  if (mutation && !sameOrigin(request)) return noStore({ error: "Origin permintaan tidak diizinkan", code: "csrf_rejected" }, 403);
  return null;
}

/**
 * The JSON body of `request`, read with a byte cap. An empty body is
 * `emptyValue` (undefined = refused). Throws HttpBodyError (400/413/415).
 */
export async function readJsonBody(request, { maxBytes, emptyValue } = {}) {
  const contentType = request.headers.get("content-type");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new HttpBodyError(413, "Isi permintaan terlalu besar");
  if (!request.body) {
    if (emptyValue !== undefined) return emptyValue;
    throw new HttpBodyError(400, "Isi permintaan kosong");
  }
  if (contentType !== null && !/^application\/json(?:\s*;|$)/i.test(contentType)) throw new HttpBodyError(415, "Isi permintaan harus JSON");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new HttpBodyError(400, "Isi permintaan tidak valid");
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new HttpBodyError(413, "Isi permintaan terlalu besar");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    if (emptyValue !== undefined) return emptyValue;
    throw new HttpBodyError(400, "Isi permintaan kosong");
  }
  if (contentType === null) throw new HttpBodyError(415, "Isi permintaan harus JSON");
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)));
  } catch {
    throw new HttpBodyError(400, "Isi permintaan bukan JSON yang valid");
  }
}

/** The response for a failed request: validation issues are field names and fixed texts only. */
export function errorResponse(error) {
  if (error instanceof HttpBodyError) return noStore({ error: error.message, code: "bad_request" }, error.status);
  if (error instanceof LlmSettingsError) {
    const body = { error: error.message, code: error.code };
    if (error.issues?.length) body.issues = error.issues.map(({ field, message }) => ({ field, message }));
    return noStore(body, settingsErrorStatus(error));
  }
  return noStore({ error: "Pengaturan AI tidak bisa diproses", code: "internal" }, 500);
}

/** A request body of exactly { provider: "<name>" }. */
export function providerRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((name) => name !== "provider") || typeof body.provider !== "string") {
    throw new HttpBodyError(400, "Isi permintaan harus { provider }");
  }
  return body.provider;
}

export function rateLimited(limiter, key) {
  const decision = limiter.consume(key);
  if (decision.allowed) return null;
  return noStore(
    { error: "Terlalu banyak permintaan. Coba lagi sebentar.", code: "rate_limited" },
    429,
    { "Retry-After": String(decision.retryAfterSeconds) },
  );
}
