// The header set and the request guard of the editor API routes (plan §9.1; T4.2).
//
// `secureRoute(handler, options)` wraps one method of a route file. Before the handler runs:
// the session (requireAuth), the origin of a mutation (sameOriginMutation), each id segment by
// its exact pattern, then the route's rate-limit bucket. Every answer leaves with nosniff,
// Cross-Origin-Resource-Policy: same-origin and, unless the handler chose a cache policy,
// no-store. An error body never carries a string that names a server directory or holds a
// Python traceback: such a string becomes null (the status and the code stay).
import { realpathSync } from "node:fs";
import path from "node:path";

import { SESSION_COOKIE, requireAuth } from "./auth.mjs";
import { retryAfterSeconds, sharedEditorRateLimits } from "./rate-limit.mjs";
import { sameOriginMutation } from "./request-security.mjs";

export const API_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-origin",
});

// next.config.mjs sends these on /projects/:id/clips/:clipId/edit (a test keeps the two equal):
// cross-origin isolation for the player (COOP + COEP), no sniffing, no framing.
export const EDITOR_PAGE_HEADERS = Object.freeze([
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// One spelling per id (lower case), the same shapes the Python CLIs check again.
export const ROUTE_PARAMS = Object.freeze({
  id: UUID,
  clipId: /^clip_[0-9a-f]{24}$/,
  taskId: UUID,
  renderId: UUID,
  sha: /^[0-9a-f]{64}$/,
  idempotencyKey: UUID,
});

const MESSAGES = Object.freeze({
  invalid_request: "Permintaan tidak valid",
  csrf_rejected: "Origin permintaan tidak diizinkan",
  rate_limited: "Terlalu banyak permintaan; tunggu sebentar lalu coba lagi",
  backend_unavailable: "Layanan editor tidak tersedia",
});
const MAX_ERROR_BODY_CHARS = 1 << 20;
const MARKERS = Object.freeze(["Traceback (most recent call last)", "/proc/self/"]);

function refusal(code, status, headers = {}) {
  return Response.json({ error: MESSAGES[code], code, messageId: `edit.${code}` },
    { status, headers: { "Cache-Control": "no-store", ...headers } });
}

/** `response` with `headers` added where it has none of that name (copied when immutable). */
function addHeaders(response, headers) {
  try {
    for (const [name, value] of Object.entries(headers)) if (!response.headers.has(name)) response.headers.set(name, value);
    return response;
  } catch {
    const copy = new Headers(response.headers);
    for (const [name, value] of Object.entries(headers)) if (!copy.has(name)) copy.set(name, value);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: copy });
  }
}

/** The API header set on `response`; a handler's own Cache-Control is kept. */
export function withSecurityHeaders(response) {
  return addHeaders(response, { ...API_HEADERS, "Cache-Control": "no-store" });
}

/** The session cookie's value, or "" (rate-limit buckets are keyed by its hash). */
export function sessionTokenOf(request) {
  for (const item of (request.headers.get("cookie") || "").split(";")) {
    const at = item.indexOf("=");
    if (at > 0 && item.slice(0, at).trim() === SESSION_COOKIE) return item.slice(at + 1).trim();
  }
  return "";
}

const realRoots = new Map();

/** The server directories an answer must never name: the jobs root (as set and resolved) and the
 * settings, resources and app directories. */
export function serverRoots(env = process.env, cwd = process.cwd()) {
  const roots = new Set();
  for (const value of [env.JOBS_ROOT || "/data/jobs", env.POTONGIN_SETTINGS_DIR, env.POTONGIN_RESOURCES_DIR, cwd]) {
    if (typeof value !== "string" || !path.isAbsolute(value)) continue;
    const resolved = path.resolve(value);
    roots.add(resolved);
    if (!realRoots.has(resolved)) {
      try { realRoots.set(resolved, realpathSync(resolved)); } catch { /* not there (yet) */ }
    }
    if (realRoots.has(resolved)) roots.add(realRoots.get(resolved));
  }
  return [...roots].filter((root) => root.length > 1);
}

function leaks(text, roots) {
  return MARKERS.some((marker) => text.includes(marker)) || roots.some((root) => text === root || text.includes(`${root}/`));
}

/** `value` with every string that names a server root or holds a traceback replaced by null. */
export function redactServerPaths(value, roots) {
  let redacted = 0;
  const walk = (item) => {
    if (typeof item === "string") {
      if (!leaks(item, roots)) return item;
      redacted += 1;
      return null;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, inner]) => [key, walk(inner)]));
    return item;
  };
  return { value: walk(value), redacted };
}

async function redactErrorBody(response, roots) {
  if (response.status < 400 || response.body === null || !/json/i.test(response.headers.get("content-type") || "")) return response;
  const text = await response.text();
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  const rebuilt = (body) => new Response(body, { status: response.status, statusText: response.statusText, headers });
  if (text.length > MAX_ERROR_BODY_CHARS) return rebuilt(JSON.stringify({ error: MESSAGES.backend_unavailable, code: "backend_unavailable" }));
  let value;
  try { value = JSON.parse(text); } catch {
    return rebuilt(leaks(text, roots) ? JSON.stringify({ error: MESSAGES.backend_unavailable, code: "backend_unavailable" }) : text);
  }
  const clean = redactServerPaths(value, roots);
  return rebuilt(clean.redacted ? JSON.stringify(clean.value) : text);
}

/**
 * One route method behind the shared guard. `params`: the id segments to check (names of
 * ROUTE_PARAMS); `limit`: the rate-limit bucket of the route (EDITOR_RATE_LIMITS), or null when
 * the route has its own or none; `after`: a last step on the handler's answer.
 */
export function secureRoute(handler, options = {}) {
  const { params = [], limit = null, after = null, authorize = requireAuth, limits = sharedEditorRateLimits, env = process.env } = options;
  for (const name of params) if (!Object.hasOwn(ROUTE_PARAMS, name)) throw new Error(`Unknown route parameter: ${name}`);
  if (typeof handler !== "function") throw new Error("A route handler is required");

  async function guarded(request, context) {
    const denied = authorize(request);
    if (denied) return denied;
    if (!["GET", "HEAD"].includes(request.method) && !sameOriginMutation(request)) return refusal("csrf_rejected", 403);
    const resolved = await context?.params;
    for (const name of params) {
      const value = resolved?.[name];
      if (typeof value !== "string" || !ROUTE_PARAMS[name].test(value)) return refusal("invalid_request", 400);
    }
    if (limit) {
      const verdict = limits().check(limit, { sessionToken: sessionTokenOf(request) || "anonymous", jobId: resolved?.id });
      if (!verdict.allowed) return refusal("rate_limited", 429, { "Retry-After": retryAfterSeconds(verdict.retryAfterMs) });
    }
    const response = await handler(request, { ...context, params: Promise.resolve(resolved) });
    if (!(response instanceof Response)) return refusal("backend_unavailable", 503);
    return after ? await after(response) : response;
  }

  return async function route(request, context) {
    let response;
    try {
      response = await guarded(request, context);
    } catch {
      response = refusal("backend_unavailable", 503);
    }
    try {
      response = await redactErrorBody(response, serverRoots(env));
    } catch {
      response = refusal("backend_unavailable", 503);
    }
    return withSecurityHeaders(response);
  };
}

/** The AI route's 202 tells when the job's LLM quota refills (frozen DTO: `llm.retryAfterMs`);
 * this adds the same time as `Retry-After`. */
export async function llmRetryAfter(response) {
  if (response.status !== 202 || response.headers.has("retry-after")) return response;
  let body;
  try { body = await response.clone().json(); } catch { return response; }
  if (body?.llm?.state !== "rate_limited" || !Number.isFinite(body.llm.retryAfterMs)) return response;
  return addHeaders(response, { "Retry-After": retryAfterSeconds(body.llm.retryAfterMs) });
}
