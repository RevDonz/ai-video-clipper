#!/usr/bin/env node
// The editor route's build output, for 08 Fase 1: "CSS editor hasil build identik byte; kenaikan
// JS rute editor <= ukuran use-intl". Measured against a running app (next start), once per ref:
//   E2E_USERNAME=… E2E_PASSWORD=… node scripts/measure-route-assets.mjs http://127.0.0.1:3217 <path> [use-intl dir]
// It signs in (as measure-ttfb.mjs), loads the page and fetches every stylesheet and script the
// HTML names under /_next/static/. CSS: each file's bytes and SHA-256 and one digest over the
// sorted hashes, so two builds compare by content, whatever the chunk names. JS: the file count
// and the raw and gzip bytes (level 9) of the scripts the page loads up front; chunks fetched
// later by a dynamic import are not counted. With a package directory it also prints that
// package's production ESM size, the bound for the JS growth. Run it on GitHub Actions.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

import { signIn } from "./measure-ttfb.mjs";

const STATIC = "/_next/static/";
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const gzipBytes = (data) => gzipSync(data, { level: 9 }).length;
const attribute = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`, "i").exec(tag)?.[1] ?? null;

/** The same-origin stylesheets and scripts an HTML page names, sorted and deduplicated. */
export function assetsOf(html) {
  const css = new Set();
  const js = new Set();
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = attribute(tag, "href");
    if (attribute(tag, "rel")?.toLowerCase() === "stylesheet" && href?.startsWith(STATIC)) css.add(href);
  }
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attribute(tag, "src");
    if (src?.startsWith(STATIC)) js.add(src);
  }
  return { css: [...css].sort(), js: [...js].sort() };
}

async function get(url, headers, fetchImpl) {
  const response = await fetchImpl(url, { headers, redirect: "manual", cache: "no-store" });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(`${new URL(url).pathname} answered ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function measureRoute(base, path, { cookie = null, fetchImpl = fetch } = {}) {
  const origin = new URL(base).origin;
  const headers = { "Accept-Language": "id-ID,id;q=0.9", ...(cookie ? { Cookie: cookie } : {}) };
  const html = (await get(`${origin}${path}`, headers, fetchImpl)).toString("utf8");
  const { css, js } = assetsOf(html);
  const cssFiles = [];
  for (const href of css) {
    const body = await get(`${origin}${href}`, headers, fetchImpl);
    cssFiles.push({ path: href, bytes: body.length, sha256: sha256(body) });
  }
  let jsBytes = 0;
  let jsGzip = 0;
  for (const src of js) {
    const body = await get(`${origin}${src}`, headers, fetchImpl);
    jsBytes += body.length;
    jsGzip += gzipBytes(body);
  }
  const hashes = cssFiles.map((file) => file.sha256).sort();
  return {
    path,
    status: 200,
    css: {
      files: cssFiles,
      bytes: cssFiles.reduce((sum, file) => sum + file.bytes, 0),
      digest: sha256(hashes.map((hash) => `${hash}\n`).join("")),
    },
    js: { files: js.length, bytes: jsBytes, gzipBytes: jsGzip },
  };
}

async function jsFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(full)));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out.sort();
}

/** A package's production ESM build (dist/esm/production/**.js): file count, raw and gzip bytes. */
export async function packageSize(root) {
  const { name, version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const files = await jsFiles(join(root, "dist", "esm", "production"));
  let bytes = 0;
  let gzip = 0;
  for (const file of files) {
    const body = await readFile(file);
    bytes += body.length;
    gzip += gzipBytes(body);
  }
  return { name, version, files: files.length, bytes, gzipBytes: gzip };
}

async function main() {
  const [base, path, packageDir] = process.argv.slice(2);
  if (!base || !path?.startsWith("/")) throw new Error("Usage: node scripts/measure-route-assets.mjs <base URL> <path> [package dir]");
  const cookie = await signIn(base, { username: process.env.E2E_USERNAME, password: process.env.E2E_PASSWORD });
  const route = await measureRoute(base, path, { cookie });
  const bound = packageDir ? await packageSize(packageDir) : null;
  process.stdout.write(`${JSON.stringify({ base: new URL(base).origin, signedIn: Boolean(cookie), route, bound }, null, 2)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
