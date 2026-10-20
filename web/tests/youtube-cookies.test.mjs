// Pengaturan "Cookies YouTube": the cookies.txt check (lib/youtube-cookies-file.mjs), the sealed
// store and its route (lib/youtube-cookies.mjs), the copy the worker hands yt-dlp, and the card's
// copy (lib/youtube-cookies-view.mjs). Every cookie value here is a plain made-up word.
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as cookiesRouteModule from "../app/api/settings/youtube-cookies/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import {
  COOKIES_FILE_HEADER,
  CookiesFileError,
  MAX_COOKIES_FILE_BYTES,
  parseCookiesFile,
} from "../lib/youtube-cookies-file.mjs";
import {
  YOUTUBE_COOKIES_FILE,
  createYoutubeCookiesRoute,
  openYoutubeCookies,
  prepareYoutubeCookies,
  readYoutubeCookiesStatus,
  removeYoutubeCookies,
  saveYoutubeCookies,
} from "../lib/youtube-cookies.mjs";
import {
  COOKIES_ACCEPT,
  MAX_COOKIES_UPLOAD_BYTES,
  cookiesErrorMessage,
  cookiesSavedMessage,
  youtubeCookiesCopy,
  youtubeCookiesState,
} from "../lib/youtube-cookies-view.mjs";

const NOW_MS = Date.parse("2026-10-21T08:00:00.000Z");
const FUTURE = String(Math.floor(NOW_MS / 1000) + 365 * 24 * 3600);
const PAST = String(Math.floor(NOW_MS / 1000) - 3600);
const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-cookies-value", APP_SESSION_SECRET: "cookies-session-".padEnd(48, "k") });

const line = (...fields) => fields.join("\t");
const LOGIN = line(".youtube.com", "TRUE", "/", "TRUE", FUTURE, "LOGIN_INFO", "nilai-login-uji");
const VISITOR = line(".youtube.com", "TRUE", "/", "TRUE", FUTURE, "VISITOR_INFO1_LIVE", "nilai-tamu-uji");
const SAPISID = line(".google.com", "TRUE", "/", "TRUE", FUTURE, "SAPISID", "nilai-google-uji");
const HTTPONLY = `#HttpOnly_${line(".youtube.com", "TRUE", "/", "TRUE", FUTURE, "__Secure-3PSID", "nilai-rahasia-uji")}`;
const OTHER_SITE = line(".bank.example", "TRUE", "/", "TRUE", FUTURE, "session", "nilai-bank-uji");
const EXPIRED = line(".youtube.com", "TRUE", "/", "TRUE", PAST, "YSC", "nilai-lama-uji");

function file(...lines) {
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

function parse(bytes) {
  return parseCookiesFile(bytes, { now: NOW_MS });
}

function rejects(bytes, code) {
  assert.throws(() => parse(bytes), (error) => error instanceof CookiesFileError && error.code === code, code);
}

// --- The cookies.txt check ------------------------------------------------------------------

test("a Netscape cookies.txt keeps its YouTube and Google cookies and counts them", () => {
  const result = parse(file(COOKIES_FILE_HEADER, "# komentar", "", LOGIN, VISITOR, SAPISID));
  assert.equal(result.count, 3);
  assert.equal(result.signedIn, true);
  assert.deepEqual(result.skipped, { otherSites: 0, expired: 0, invalid: 0 });
  assert.equal(result.text, `${COOKIES_FILE_HEADER}\n${LOGIN}\n${VISITOR}\n${SAPISID}\n`);
});

test("a UTF-8 BOM, CRLF line ends and a missing final newline are fixed", () => {
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${COOKIES_FILE_HEADER}\r\n${LOGIN}\r\n${VISITOR}`)]);
  const result = parse(bytes);
  assert.equal(result.count, 2);
  assert.equal(result.text, `${COOKIES_FILE_HEADER}\n${LOGIN}\n${VISITOR}\n`);
});

test("#HttpOnly_ lines are cookies, not comments, and keep their prefix", () => {
  const result = parse(file(COOKIES_FILE_HEADER, HTTPONLY));
  assert.equal(result.count, 1);
  assert.equal(result.signedIn, true);
  assert.equal(result.text, `${COOKIES_FILE_HEADER}\n${HTTPONLY}\n`);
});

test("without the header, a file of valid tab-separated lines is accepted and gets the header", () => {
  const result = parse(file(LOGIN, VISITOR));
  assert.equal(result.count, 2);
  assert.ok(result.text.startsWith(`${COOKIES_FILE_HEADER}\n`));
  // yt-dlp refuses a file whose first line is not the header: the copy always starts with it.
  assert.ok(parse(file("# HTTP Cookie File", LOGIN)).text.startsWith(`${COOKIES_FILE_HEADER}\n`));
});

test("other sites' cookies, expired cookies and broken lines are dropped and counted", () => {
  const result = parse(file(COOKIES_FILE_HEADER, LOGIN, OTHER_SITE, EXPIRED, "baris rusak", line(".youtube.com", "TRUE", "/", "TRUE", "besok", "PREF", "x")));
  assert.equal(result.count, 1);
  assert.deepEqual(result.skipped, { otherSites: 1, expired: 1, invalid: 2 });
  assert.doesNotMatch(result.text, /bank|nilai-lama|PREF/);
});

test("session cookies (expiry 0 or empty) are kept as 0", () => {
  const session = line(".youtube.com", "TRUE", "/", "FALSE", "0", "YSC", "nilai-sesi-uji");
  const empty = line("www.youtube.com", "FALSE", "/", "FALSE", "", "PREF", "nilai-pref-uji");
  const result = parse(file(COOKIES_FILE_HEADER, session, empty));
  assert.equal(result.count, 2);
  assert.match(result.text, /\t0\tYSC\t/);
  assert.match(result.text, /\t0\tPREF\t/);
});

test("safe fixes: the subdomain flag follows the leading dot, a decimal expiry is truncated, spaces for tabs", () => {
  const wrongFlag = line("www.youtube.com", "TRUE", "/", "TRUE", FUTURE, "PREF", "nilai-pref-uji");
  const decimal = line(".youtube.com", "true", "/", "true", `${FUTURE}.75`, "YSC", "nilai-ysc-uji");
  const spaced = [".google.com", "TRUE", "/", "TRUE", FUTURE, "SID", "nilai-sid-uji"].join("   ");
  const result = parse(file(COOKIES_FILE_HEADER, wrongFlag, decimal, spaced));
  assert.equal(result.count, 3);
  assert.equal(result.text, [
    COOKIES_FILE_HEADER,
    line("www.youtube.com", "FALSE", "/", "TRUE", FUTURE, "PREF", "nilai-pref-uji"),
    line(".youtube.com", "TRUE", "/", "TRUE", FUTURE, "YSC", "nilai-ysc-uji"),
    line(".google.com", "TRUE", "/", "TRUE", FUTURE, "SID", "nilai-sid-uji"),
    "",
  ].join("\n"));
});

test("a file without a login cookie is kept but reported as not signed in", () => {
  const result = parse(file(COOKIES_FILE_HEADER, VISITOR));
  assert.equal(result.count, 1);
  assert.equal(result.signedIn, false);
});

test("JSON exports are refused with their own code", () => {
  rejects(Buffer.from('[{"domain": ".youtube.com", "name": "SID", "value": "x"}]'), "cookies_json");
  rejects(Buffer.from('﻿  {"cookies": []}'), "cookies_json");
});

test("UTF-16 files are refused with their own code, with or without a BOM", () => {
  const text = `${COOKIES_FILE_HEADER}\n${LOGIN}\n`;
  rejects(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]), "cookies_utf16");
  rejects(Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, "utf16le").swap16()]), "cookies_utf16");
  rejects(Buffer.from(text, "utf16le"), "cookies_utf16");
});

test("binary, empty, oversized and cookie-less files are refused", () => {
  rejects(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0xff]), "cookies_not_text");
  rejects(Buffer.alloc(0), "cookies_empty");
  rejects(Buffer.from("\n\n  \n"), "cookies_empty");
  rejects(Buffer.alloc(MAX_COOKIES_FILE_BYTES + 1, 0x41), "cookies_too_large");
  rejects(file(COOKIES_FILE_HEADER, "# hanya komentar"), "cookies_empty");
  rejects(file("nama=nilai; nama2=nilai2"), "cookies_not_netscape");
  rejects(file("Ini catatan biasa", "bukan cookies sama sekali"), "cookies_not_netscape");
  rejects(file(COOKIES_FILE_HEADER, OTHER_SITE), "cookies_no_youtube");
  rejects(file(COOKIES_FILE_HEADER, EXPIRED), "cookies_expired");
});

test("a headerless file with any broken line is not taken for a cookies file", () => {
  rejects(file(LOGIN, "baris rusak"), "cookies_not_netscape");
});

test("domains that only look like YouTube stay out", () => {
  const lookalike = line(".notyoutube.com", "TRUE", "/", "TRUE", FUTURE, "SID", "nilai-palsu-uji");
  const suffix = line(".youtube.com.example", "TRUE", "/", "TRUE", FUTURE, "SID", "nilai-palsu-uji");
  const result = parse(file(COOKIES_FILE_HEADER, LOGIN, lookalike, suffix));
  assert.equal(result.count, 1);
  assert.equal(result.skipped.otherSites, 2);
});

// --- Sealed store ---------------------------------------------------------------------------

async function sandbox(t, extra = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "yt-cookies-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const jobs = path.join(base, "jobs");
  await mkdir(jobs, { recursive: true });
  return { base, settings: path.join(base, "settings"), env: { ...AUTH, PATH: process.env.PATH, JOBS_ROOT: jobs, POTONGIN_SETTINGS_DIR: path.join(base, "settings"), ...extra } };
}

test("saved cookies are sealed in a 0600 file in a 0700 folder and open again with the same secret", async (t) => {
  const { env, settings } = await sandbox(t);
  const saved = await saveYoutubeCookies(file(COOKIES_FILE_HEADER, LOGIN, HTTPONLY, OTHER_SITE), { env, now: new Date(NOW_MS) });
  assert.deepEqual(saved.cookies, { count: 2, signedIn: true, uploadedAt: "2026-10-21T08:00:00.000Z" });
  assert.deepEqual(saved.skipped, { otherSites: 1, expired: 0, invalid: 0 });

  const stored = path.join(settings, YOUTUBE_COOKIES_FILE);
  assert.equal((await stat(stored)).mode & 0o777, 0o600);
  assert.equal((await stat(settings)).mode & 0o777, 0o700);
  const raw = await readFile(stored, "utf8");
  for (const value of ["nilai-login-uji", "nilai-rahasia-uji", "LOGIN_INFO", "youtube.com", "nilai-bank-uji"]) assert.ok(!raw.includes(value), value);
  assert.deepEqual(await readdir(settings), [YOUTUBE_COOKIES_FILE], "no temporary file is left");

  const opened = await openYoutubeCookies(env);
  assert.equal(opened.state, "ok");
  assert.equal(opened.text, `${COOKIES_FILE_HEADER}\n${LOGIN}\n${HTTPONLY}\n`);
  assert.deepEqual(await readYoutubeCookiesStatus(env), {
    cookies: { count: 2, signedIn: true, uploadedAt: "2026-10-21T08:00:00.000Z" }, problem: null, secretConfigured: true,
  });
});

test("cookies sealed under another secret, or tampered with, are reported unreadable and never guessed", async (t) => {
  const { env, settings } = await sandbox(t);
  await saveYoutubeCookies(file(COOKIES_FILE_HEADER, LOGIN), { env, now: new Date(NOW_MS) });
  const rotated = { ...env, APP_SESSION_SECRET: "another-session-".padEnd(48, "r") };
  assert.deepEqual(await openYoutubeCookies(rotated), { state: "unreadable" });
  const status = await readYoutubeCookiesStatus(rotated);
  assert.equal(status.problem, "unreadable");
  assert.equal(status.cookies.count, 1);

  // POTONGIN_SETTINGS_SECRET wins over the session secret, as for the LLM keys.
  assert.deepEqual(await openYoutubeCookies({ ...env, POTONGIN_SETTINGS_SECRET: "settings-secret-".padEnd(48, "s") }), { state: "unreadable" });

  const stored = path.join(settings, YOUTUBE_COOKIES_FILE);
  const document = JSON.parse(await readFile(stored, "utf8"));
  const flipped = Buffer.from(document.sealed.ciphertext, "base64");
  flipped[0] ^= 1;
  await writeFile(stored, JSON.stringify({ ...document, sealed: { ...document.sealed, ciphertext: flipped.toString("base64") } }));
  assert.deepEqual(await openYoutubeCookies(env), { state: "unreadable" });

  await writeFile(stored, "{bukan json");
  assert.deepEqual(await openYoutubeCookies(env), { state: "corrupt" });
  assert.equal((await readYoutubeCookiesStatus(env)).problem, "corrupt");
});

test("without a usable secret nothing is saved", async (t) => {
  const { env, settings } = await sandbox(t, { APP_SESSION_SECRET: "", POTONGIN_SETTINGS_SECRET: "" });
  await assert.rejects(saveYoutubeCookies(file(LOGIN), { env }), { code: "secret_missing" });
  await assert.rejects(lstat(settings), { code: "ENOENT" });
  assert.deepEqual(await readYoutubeCookiesStatus(env), { cookies: null, problem: null, secretConfigured: false });
  assert.deepEqual(await openYoutubeCookies(env), { state: "none" });
});

test("removing the cookies deletes the sealed file", async (t) => {
  const { env, settings } = await sandbox(t);
  await saveYoutubeCookies(file(LOGIN), { env });
  await removeYoutubeCookies(env);
  assert.deepEqual(await readdir(settings), []);
  assert.deepEqual(await openYoutubeCookies(env), { state: "none" });
  await removeYoutubeCookies(env);
});

// --- Route ----------------------------------------------------------------------------------

function authorize(request) {
  return isAuthorized(request, AUTH) ? null
    : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function request(method, { body, origin = "http://local", cookie = true, contentType = "text/plain", length } = {}) {
  const headers = { Host: "local" };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (body !== undefined && contentType) headers["Content-Type"] = contentType;
  if (length !== undefined) headers["Content-Length"] = String(length);
  return new Request("http://local/api/settings/youtube-cookies", { method, headers, body, duplex: "half" });
}

async function read(response) {
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null, cacheControl: response.headers.get("cache-control") };
}

test("the route needs a session for every method and the same origin for changes", async (t) => {
  const { env } = await sandbox(t);
  for (const method of ["GET", "POST", "DELETE"]) {
    const answer = await read(await cookiesRouteModule[method](request(method, { cookie: false, body: method === "POST" ? file(LOGIN) : undefined })));
    assert.equal(answer.status, 401, method);
    assert.equal(answer.cacheControl, "no-store", method);
  }
  const route = createYoutubeCookiesRoute({ authorize, env });
  for (const origin of ["https://evil.example", null]) {
    assert.equal((await route.POST(request("POST", { body: file(LOGIN), origin }))).status, 403);
    assert.equal((await route.DELETE(request("DELETE", { origin }))).status, 403);
  }
  assert.deepEqual(await openYoutubeCookies(env), { state: "none" });
});

test("upload, status and removal through the route never return a cookie value", async (t) => {
  const { env } = await sandbox(t);
  const route = createYoutubeCookiesRoute({ authorize, env, now: () => new Date(NOW_MS) });

  const empty = await read(await route.GET(request("GET")));
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.body, { cookies: null, problem: null, secretConfigured: true });

  const upload = await read(await route.POST(request("POST", { body: file(COOKIES_FILE_HEADER, LOGIN, HTTPONLY, OTHER_SITE, EXPIRED) })));
  assert.equal(upload.status, 200, upload.text);
  assert.equal(upload.cacheControl, "no-store");
  assert.deepEqual(upload.body, {
    cookies: { count: 2, signedIn: true, uploadedAt: "2026-10-21T08:00:00.000Z" },
    skipped: { otherSites: 1, expired: 1, invalid: 0 },
    problem: null,
    secretConfigured: true,
  });

  const status = await read(await route.GET(request("GET")));
  assert.deepEqual(status.body.cookies, { count: 2, signedIn: true, uploadedAt: "2026-10-21T08:00:00.000Z" });
  for (const answer of [upload, status]) {
    for (const value of ["nilai-login-uji", "nilai-rahasia-uji", "LOGIN_INFO", "__Secure-3PSID", "nilai-bank-uji"]) assert.ok(!answer.text.includes(value), value);
  }

  const removed = await read(await route.DELETE(request("DELETE")));
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body, { cookies: null, problem: null, secretConfigured: true });
  assert.deepEqual(await openYoutubeCookies(env), { state: "none" });
});

test("a refused file answers with its code and a fixed message, and keeps the stored cookies", async (t) => {
  const { env } = await sandbox(t);
  const route = createYoutubeCookiesRoute({ authorize, env });
  await route.POST(request("POST", { body: file(LOGIN) }));
  for (const [body, code] of [
    [Buffer.from('[{"name": "SID", "value": "nilai-json-uji"}]'), "cookies_json"],
    [Buffer.from(`${COOKIES_FILE_HEADER}\n${LOGIN}\n`, "utf16le"), "cookies_utf16"],
    [file(COOKIES_FILE_HEADER, OTHER_SITE), "cookies_no_youtube"],
  ]) {
    const answer = await read(await route.POST(request("POST", { body })));
    assert.equal(answer.status, 422, code);
    assert.equal(answer.body.code, code);
    assert.equal(typeof answer.body.error, "string");
    assert.ok(!answer.text.includes("nilai-"), code);
  }
  assert.equal((await openYoutubeCookies(env)).state, "ok");
});

test("the upload is a text body under the size cap", async (t) => {
  const { env } = await sandbox(t);
  const route = createYoutubeCookiesRoute({ authorize, env });
  const wrongType = await read(await route.POST(request("POST", { body: file(LOGIN), contentType: "application/json" })));
  assert.equal(wrongType.status, 415);
  assert.equal(wrongType.body.code, "unsupported_media_type");
  assert.equal((await route.POST(request("POST", { body: file(LOGIN), contentType: "application/octet-stream" }))).status, 200);

  const big = Buffer.alloc(MAX_COOKIES_FILE_BYTES + 10, 0x41);
  const tooBig = await read(await route.POST(request("POST", { body: big })));
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.code, "cookies_too_large");
  const declared = await read(await route.POST(request("POST", { body: file(LOGIN), length: MAX_COOKIES_FILE_BYTES + 1 })));
  assert.equal(declared.status, 413);
});

test("without the sealing secret the route says so and stores nothing", async (t) => {
  const { env } = await sandbox(t, { APP_SESSION_SECRET: "", POTONGIN_SETTINGS_SECRET: "" });
  const route = createYoutubeCookiesRoute({ authorize, env });
  const answer = await read(await route.POST(request("POST", { body: file(LOGIN) })));
  assert.equal(answer.status, 503);
  assert.equal(answer.body.code, "secret_missing");
  assert.deepEqual((await read(await route.GET(request("GET")))).body, { cookies: null, problem: null, secretConfigured: false });
});

// --- The copy for yt-dlp ---------------------------------------------------------------------

test("the worker's copy is a 0600 file in a private 0700 folder, gone after dispose", async (t) => {
  const { env, base } = await sandbox(t);
  const tmpDir = path.join(base, "tmp");
  await mkdir(tmpDir);
  await saveYoutubeCookies(file(COOKIES_FILE_HEADER, LOGIN), { env });
  const copy = await prepareYoutubeCookies(env, { tmpDir, log: () => assert.fail("nothing to log") });
  assert.ok(path.isAbsolute(copy.file));
  assert.equal((await stat(copy.file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(copy.file))).mode & 0o777, 0o700);
  assert.equal(await readFile(copy.file, "utf8"), `${COOKIES_FILE_HEADER}\n${LOGIN}\n`);
  await copy.dispose();
  await copy.dispose();
  assert.deepEqual(await readdir(tmpDir), []);
});

test("no stored cookies means no copy; unreadable ones are logged by reason only", async (t) => {
  const { env, base } = await sandbox(t);
  const tmpDir = path.join(base, "tmp");
  await mkdir(tmpDir);
  assert.equal(await prepareYoutubeCookies(env, { tmpDir, log: () => assert.fail("nothing to log") }), null);
  await saveYoutubeCookies(file(LOGIN), { env });
  const logs = [];
  const rotated = { ...env, APP_SESSION_SECRET: "another-session-".padEnd(48, "r") };
  assert.equal(await prepareYoutubeCookies(rotated, { tmpDir, log: (text) => logs.push(text) }), null);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unreadable/);
  assert.doesNotMatch(logs.join("\n"), /nilai-|LOGIN_INFO/);
  assert.deepEqual(await readdir(tmpDir), []);
});

test("a copy left by a runner that died is removed by the next one", async (t) => {
  const { env, base } = await sandbox(t);
  const tmpDir = path.join(base, "tmp");
  await mkdir(tmpDir);
  await saveYoutubeCookies(file(LOGIN), { env });
  // A pid far above pid_max on Linux belongs to no process.
  const stale = path.join(tmpDir, "potongin-yt-cookies-999999999-abcdef");
  await mkdir(stale, { mode: 0o700 });
  await writeFile(path.join(stale, "cookies.txt"), "sisa", { mode: 0o600 });
  const live = path.join(tmpDir, `potongin-yt-cookies-${process.pid}-ghijkl`);
  await mkdir(live, { mode: 0o700 });
  const copy = await prepareYoutubeCookies(env, { tmpDir, log: () => {} });
  const names = await readdir(tmpDir);
  assert.ok(!names.includes(path.basename(stale)), "the dead runner's copy is gone");
  assert.ok(names.includes(path.basename(live)), "a live runner's folder stays");
  await copy.dispose();
});

// --- The card's copy ------------------------------------------------------------------------

test("the card reads only the status fields and caps uploads like the server", () => {
  assert.equal(MAX_COOKIES_UPLOAD_BYTES, MAX_COOKIES_FILE_BYTES);
  assert.match(COOKIES_ACCEPT, /\.txt/);
  assert.deepEqual(youtubeCookiesState(null), { cookies: null, problem: null, secretConfigured: false });
  assert.deepEqual(youtubeCookiesState({ cookies: { count: 3, signedIn: false, uploadedAt: "2026-10-21T08:00:00.000Z", text: "x" }, problem: "unreadable", secretConfigured: true }), {
    cookies: { count: 3, signedIn: false, uploadedAt: "2026-10-21T08:00:00.000Z" }, problem: "unreadable", secretConfigured: true,
  });
  assert.equal(youtubeCookiesState({ cookies: { count: -1, signedIn: true, uploadedAt: "x" } }).cookies, null);
  assert.equal(youtubeCookiesState({ problem: "lain" }).problem, null);
});

test("the card's copy advises a separate Google account and explains each refusal", () => {
  const copy = youtubeCookiesCopy();
  assert.ok(copy.facts.some((fact) => /akun Google terpisah/.test(fact)));
  for (const text of [copy.where, copy.hint, copy.notSignedIn, copy.unreadable, copy.secretMissing, ...copy.facts]) {
    assert.ok(text.length > 0 && text.length <= 140, text);
    assert.doesNotMatch(text, /—|\bkamu\b|\bV[1-3]\b/);
  }
  for (const code of ["cookies_json", "cookies_utf16", "cookies_not_text", "cookies_not_netscape", "cookies_empty", "cookies_no_youtube", "cookies_expired", "cookies_too_large", "secret_missing", "unsupported_media_type"]) {
    const message = cookiesErrorMessage({ status: 422, code });
    assert.ok(message.length > 0 && message.length <= 120, `${code}: ${message}`);
    assert.notEqual(message, cookiesErrorMessage({ status: 500, code: "lain" }), code);
  }
  assert.match(cookiesErrorMessage({ status: 422, code: "cookies_json" }), /JSON/);
  assert.match(cookiesErrorMessage({ status: 422, code: "cookies_utf16" }), /UTF-8/);
  assert.match(cookiesErrorMessage({ status: 401 }), /Sesi login/);
  assert.equal(cookiesSavedMessage({ cookies: { count: 2 }, skipped: { otherSites: 0, expired: 0, invalid: 0 } }), "2 cookie YouTube tersimpan.");
  assert.equal(
    cookiesSavedMessage({ cookies: { count: 2 }, skipped: { otherSites: 120, expired: 1, invalid: 3 } }),
    "2 cookie YouTube tersimpan. Dibuang: 120 dari situs lain, 1 kedaluwarsa, 3 baris rusak.",
  );
});
