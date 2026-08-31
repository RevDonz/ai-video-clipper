import crypto from "node:crypto";
import { isIP } from "node:net";

const DEFAULT_FORM_BYTES = 4096;
const DEFAULT_ATTEMPTS = 8;
const DEFAULT_WINDOW_MS = 15 * 60 * 1000;

function boundedInteger(raw, fallback, name, minimum, maximum) {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid request security configuration: ${name}`);
  }
  return value;
}

export function sameOriginMutation(request) {
  try {
    const origin = new URL(request.headers.get("origin"));
    return origin.origin === request.headers.get("origin")
      && origin.host === request.headers.get("host")
      && [null, "same-origin"].includes(request.headers.get("sec-fetch-site"));
  } catch {
    return false;
  }
}

export async function readBoundedUrlEncodedForm(request, maximum = DEFAULT_FORM_BYTES) {
  if (!request?.body || request.bodyUsed || request.signal?.aborted
      || !Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid form request");
  const contentType = request.headers.get("content-type") || "";
  if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(contentType)) throw new Error("Invalid form request");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new Error("Invalid form request");
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("Invalid form request");
      total += value.byteLength;
      if (total > maximum) {
        await reader.cancel();
        throw new Error("Invalid form request");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0 || (declared !== null && Number(declared) !== total)) throw new Error("Invalid form request");
  const raw = Buffer.concat(chunks, total).toString("utf8");
  if (Buffer.byteLength(raw, "utf8") !== total || raw.includes("\uFFFD")) throw new Error("Invalid form request");
  for (const component of raw.split(/[&=]/)) {
    if (/%(?![0-9A-Fa-f]{2})/.test(component)) throw new Error("Invalid form request");
    let decoded;
    try { decoded = decodeURIComponent(component.replace(/\+/g, " ")); } catch { throw new Error("Invalid form request"); }
    if (decoded.includes("\uFFFD")) throw new Error("Invalid form request");
  }
  return new URLSearchParams(raw);
}

export function parseAuthRateLimitConfig(env = process.env) {
  return {
    attempts: boundedInteger(env.AUTH_RATE_LIMIT_ATTEMPTS, DEFAULT_ATTEMPTS, "AUTH_RATE_LIMIT_ATTEMPTS", 1, 100),
    windowMs: boundedInteger(env.AUTH_RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS, "AUTH_RATE_LIMIT_WINDOW_MS", 1000, 86_400_000),
  };
}

export class AuthRateLimiter {
  constructor({ attempts, windowMs, maximumKeys = 10_000 }) {
    if (!Number.isSafeInteger(attempts) || attempts < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1
        || !Number.isSafeInteger(maximumKeys) || maximumKeys < 2) throw new Error("Invalid auth rate limiter");
    this.attempts = attempts;
    this.windowMs = windowMs;
    this.maximumKeys = maximumKeys;
    this.entries = new Map();
  }

  consume(key, now = Date.now()) {
    if (typeof key !== "string" || !key || !Number.isFinite(now)) throw new Error("Invalid auth rate-limit key");
    const previous = this.entries.get(key);
    if (!previous) {
      for (const [candidate, value] of this.entries) {
        if (now >= value.resetAt) this.entries.delete(candidate);
      }
      if (this.entries.size >= this.maximumKeys) {
        const earliest = Math.min(...Array.from(this.entries.values(), (value) => value.resetAt));
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((earliest - now) / 1000)) };
      }
    }
    const entry = !previous || now >= previous.resetAt ? { count: 0, resetAt: now + this.windowMs } : previous;
    entry.count += 1;
    this.entries.delete(key);
    this.entries.set(key, entry);

    return entry.count <= this.attempts
      ? { allowed: true, retryAfterSeconds: 0 }
      : { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }

  reset(key) {
    this.entries.delete(key);
  }
}

export function authRateLimitKeys(request, username, env = process.env) {
  const mode = env.AUTH_TRUSTED_CLIENT_IP_HEADER;
  const supplied = mode === "cloudflare" ? request.headers.get("cf-connecting-ip")
    : mode === "nginx" ? request.headers.get("x-real-ip") : null;
  const client = supplied && isIP(supplied) ? supplied : "untrusted-proxy-client";
  const normalized = typeof username === "string" ? username.normalize("NFC").toLowerCase().slice(0, 256) : "";
  const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
  return [`client:${digest(client.slice(0, 256))}`, `user:${digest(normalized)}`];
}
