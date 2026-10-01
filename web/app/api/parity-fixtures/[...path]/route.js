// Fixtures for the parity harnesses (plan §11.1 T1.2b text, §11.2 T2.4 player): the manifests,
// ASS samples, fonts, plate frames and FFmpeg references written by
// scripts/parity/reference_text.py and scripts/parity/player_fixtures.py (player/...), plus the
// pinned JASSUB worker glue and wasm (served byte for byte from the installed package, because
// the adapter loads them unbundled: see web/lib/editor/player/text-layer.mjs).
//
// Dev and CI only: every request is a 404 unless POTONGIN_PARITY_HARNESS=1 and the session is
// valid, and files are served only from POTONGIN_PARITY_FIXTURES (absolute path, realpath
// containment, no symlink as the final component, allowlisted extensions, bounded size).
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import { SESSION_COOKIE, verifySessionToken } from "../../../../lib/auth.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const FIXTURE_TYPES = {
  ".json": "application/json",
  ".ass": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  // The player harness (T2.4, scripts/parity/player_fixtures.py): plate cells and the auto
  // render, preview mixes, and the reference PCM (s16le) of P-AUD's browser half.
  ".mp4": "video/mp4",
  ".flac": "audio/flac",
  ".pcm": "application/octet-stream",
};
const JASSUB_FILES = {
  "jassub-worker.js": "text/javascript; charset=utf-8",
  "jassub-worker.wasm": "application/wasm",
};
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_DEPTH = 5;
const MAX_BYTES = 64 * 1024 * 1024;

export function parityHarnessAllowed(token, env = process.env) {
  return env.POTONGIN_PARITY_HARNESS === "1" && verifySessionToken(token, env);
}

function sessionToken(request) {
  const header = request.headers.get("cookie") || "";
  for (const item of header.split(";")) {
    const separator = item.indexOf("=");
    if (separator > 0 && item.slice(0, separator).trim() === SESSION_COOKIE) {
      return item.slice(separator + 1).trim();
    }
  }
  return null;
}

function notFound() {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

async function resolveFile(segments, env) {
  if (!Array.isArray(segments) || segments.length < 1 || segments.length > MAX_DEPTH) return null;
  if (!segments.every((segment) => typeof segment === "string" && SEGMENT.test(segment))) return null;
  if (segments[0] === "jassub") {
    const type = segments.length === 2 ? JASSUB_FILES[segments[1]] : undefined;
    if (!type) return null;
    const root = path.join(process.cwd(), "node_modules", "jassub", "dist", "wasm");
    return { root, file: path.join(root, segments[1]), type };
  }
  const type = FIXTURE_TYPES[path.extname(segments.at(-1))];
  const root = env.POTONGIN_PARITY_FIXTURES;
  if (!type || !root || !path.isAbsolute(root)) return null;
  return { root, file: path.join(root, ...segments), type };
}

async function readContained({ root, file }) {
  let realRoot;
  let realFile;
  try {
    realRoot = await realpath(root);
    realFile = await realpath(file);
  } catch {
    return null;
  }
  if (!realFile.startsWith(realRoot + path.sep)) return null;
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) return null;
    return await handle.readFile();
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

// One "bytes=a-b", "bytes=a-" or "bytes=-n" range (what a <video> asks for); null when absent,
// "invalid" when it cannot be satisfied.
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return "invalid";
  let start;
  let end;
  if (match[1] === "") {
    const count = Number(match[2]);
    if (!count) return "invalid";
    start = Math.max(0, size - count);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "invalid";
  return { start, end };
}

async function handle(request, { params }, head) {
  if (!parityHarnessAllowed(sessionToken(request))) return notFound();
  const target = await resolveFile((await params).path, process.env);
  if (!target) return notFound();
  const body = await readContained(target);
  if (!body) return notFound();
  const headers = {
    "Content-Type": target.type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  const range = parseRange(request.headers.get("range"), body.length);
  if (range === "invalid") {
    return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${body.length}` } });
  }
  if (range) {
    const part = body.subarray(range.start, range.end + 1);
    return new Response(head ? null : part, {
      status: 206,
      headers: { ...headers, "Content-Length": String(part.length),
        "Content-Range": `bytes ${range.start}-${range.end}/${body.length}` },
    });
  }
  return new Response(head ? null : body, {
    status: 200,
    headers: { ...headers, "Content-Length": String(body.length) },
  });
}

export async function GET(request, context) {
  return handle(request, context, false);
}

export async function HEAD(request, context) {
  return handle(request, context, true);
}
