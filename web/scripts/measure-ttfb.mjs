#!/usr/bin/env node
// Time to first byte of the pages the i18n work made dynamic (rombak 07 §5.4, 08 Fase 1):
// /, /dashboard and /login, measured against a running app (next start) before and after.
//   E2E_USERNAME=… E2E_PASSWORD=… node scripts/measure-ttfb.mjs http://127.0.0.1:3217 [samples]
// /dashboard needs a session: the script signs in through the login form first (credentials from
// the environment, never printed). It prints one JSON object: per path the status and the median,
// p90, min and max in milliseconds over `samples` requests, after two warm-up requests. Run it on
// GitHub Actions, not on the owner's PC.
import { pathToFileURL } from "node:url";

export const PATHS = Object.freeze(["/", "/dashboard", "/login"]);
const WARMUP = 2;

/** Nearest-rank percentile of `values` (0 < p <= 100). */
export function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

export function summarize(values) {
  const round = (value) => (value === null ? null : Math.round(value * 10) / 10);
  return {
    samples: values.length,
    medianMs: round(percentile(values, 50)),
    p90Ms: round(percentile(values, 90)),
    minMs: round(values.length ? Math.min(...values) : null),
    maxMs: round(values.length ? Math.max(...values) : null),
  };
}

/** The session cookie from signing in through the login form, or null without credentials. */
export async function signIn(base, { username, password, fetchImpl = fetch } = {}) {
  if (!username || !password) return null;
  const origin = new URL(base).origin;
  const response = await fetchImpl(`${origin}/api/auth/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: origin },
    body: new URLSearchParams({ username, password, next: "/dashboard" }).toString(),
  });
  const cookie = response.headers.get("set-cookie");
  await response.body?.cancel();
  const session = cookie ? /(?:^|,\s*)(potongin_session=[^;]+)/.exec(cookie)?.[1] : null;
  if (!session) throw new Error(`Sign-in failed (status ${response.status})`);
  return session;
}

/** Milliseconds until the response headers arrive for one GET (the body is then discarded). */
async function once(url, headers, fetchImpl, now) {
  const start = now();
  const response = await fetchImpl(url, { headers, redirect: "manual", cache: "no-store" });
  const elapsed = now() - start;
  await response.body?.cancel();
  return { elapsed, status: response.status };
}

export async function measure(base, { samples = 15, cookie = null, paths = PATHS, fetchImpl = fetch, now = () => performance.now() } = {}) {
  const origin = new URL(base).origin;
  const headers = { "Accept-Language": "id-ID,id;q=0.9", ...(cookie ? { Cookie: cookie } : {}) };
  const out = {};
  for (const path of paths) {
    const url = `${origin}${path}`;
    let status = null;
    for (let i = 0; i < WARMUP; i += 1) await once(url, headers, fetchImpl, now);
    const values = [];
    for (let i = 0; i < samples; i += 1) {
      const result = await once(url, headers, fetchImpl, now);
      status = result.status;
      values.push(result.elapsed);
    }
    out[path] = { status, ...summarize(values) };
  }
  return out;
}

async function main() {
  const [base, rawSamples] = process.argv.slice(2);
  if (!base) throw new Error("Usage: node scripts/measure-ttfb.mjs <base URL> [samples]");
  const samples = rawSamples === undefined ? 15 : Number(rawSamples);
  if (!Number.isSafeInteger(samples) || samples < 1 || samples > 500) throw new Error("samples must be 1..500");
  const cookie = await signIn(base, { username: process.env.E2E_USERNAME, password: process.env.E2E_PASSWORD });
  const result = await measure(base, { samples, cookie });
  process.stdout.write(`${JSON.stringify({ base: new URL(base).origin, signedIn: Boolean(cookie), samples, pages: result }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
