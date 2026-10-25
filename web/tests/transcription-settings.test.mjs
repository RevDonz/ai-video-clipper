// Pengaturan "Transkripsi": the opt-in Groq switch and its key (lib/transcription-settings.mjs),
// the route, the environment the worker hands the engine, and the card's view model
// (lib/transcription-settings-view.mjs). Every key here is a made-up value.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import * as transcriptionRouteModule from "../app/api/settings/transcription/route.js";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import { saveLlmSettings } from "../lib/llm-settings.mjs";
import {
  GROQ_KEY_ENV,
  GROQ_SWITCH_ENV,
  TRANSCRIPTION_FILE,
  TranscriptionSettingsError,
  createTranscriptionSettingsRoute,
  readTranscriptionView,
  saveTranscriptionSettings,
  transcriptionEngineEnv,
} from "../lib/transcription-settings.mjs";
import { loadNamespace } from "../lib/i18n/catalog.mjs";
import { settingsText } from "./support/settings-text.mjs";
import {
  GROQ_KEY_URL,
  transcriptionErrorMessage,
  transcriptionNotice,
  transcriptionSavedMessage,
  transcriptionState,
} from "../lib/transcription-settings-view.mjs";

const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-transcription-value", APP_SESSION_SECRET: "transcription-session-".padEnd(48, "t") });
const OWN_KEY = "groq-own-key-1111aaaa";
const LLM_KEY = "groq-llm-key-2222bbbb";
const NOW = new Date("2026-10-21T09:00:00.000Z");

async function sandbox(t, extra = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), "transcription-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const jobs = path.join(base, "jobs");
  await mkdir(jobs, { recursive: true });
  const settings = path.join(base, "settings");
  return { settings, env: { ...AUTH, PATH: process.env.PATH, JOBS_ROOT: jobs, POTONGIN_SETTINGS_DIR: settings, ...extra } };
}

const replace = (value) => ({ action: "replace", value });

function llmWithGroq(extra = {}) {
  return {
    enabled: true, freeOnly: true,
    providers: [{ provider: "groq", enabled: true, apiKey: replace(LLM_KEY), ...extra }],
  };
}

// --- Store ----------------------------------------------------------------------------------

test("Groq is off and keyless until the owner saves it", async (t) => {
  const { env } = await sandbox(t);
  assert.deepEqual(await readTranscriptionView(env), {
    enabled: false, key: "missing", ownKey: false, llmKey: false, secretConfigured: true, updatedAt: null, problem: null,
  });
});

test("the switch and an own key are saved sealed in a 0600 file beside the LLM settings", async (t) => {
  const { env, settings } = await sandbox(t);
  const view = await saveTranscriptionSettings({ enabled: true, apiKey: replace(` ${OWN_KEY}\n`) }, { env, now: NOW });
  assert.deepEqual(view, {
    enabled: true, key: "own", ownKey: true, llmKey: false, secretConfigured: true, updatedAt: NOW.toISOString(), problem: null,
  });
  const file = path.join(settings, TRANSCRIPTION_FILE);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(settings)).mode & 0o777, 0o700);
  assert.ok(!(await readFile(file, "utf8")).includes(OWN_KEY), "the key is sealed");
  assert.deepEqual(await readdir(settings), [TRANSCRIPTION_FILE], "no temporary file is left");
  assert.deepEqual(await readTranscriptionView(env), view);
});

test("keep leaves the key, clear removes it, and switching off keeps it for later", async (t) => {
  const { env } = await sandbox(t);
  await saveTranscriptionSettings({ enabled: true, apiKey: replace(OWN_KEY) }, { env, now: NOW });
  const off = await saveTranscriptionSettings({ enabled: false }, { env, now: NOW });
  assert.equal(off.enabled, false);
  assert.equal(off.key, "own");
  const kept = await saveTranscriptionSettings({ enabled: true, apiKey: { action: "keep" } }, { env, now: NOW });
  assert.equal(kept.key, "own");
  const cleared = await saveTranscriptionSettings({ enabled: true, apiKey: { action: "clear" } }, { env, now: NOW });
  assert.deepEqual([cleared.key, cleared.ownKey], ["missing", false]);
});

test("a Groq key saved in Pengaturan AI is reused and wins over the own key", async (t) => {
  const { env } = await sandbox(t);
  await saveTranscriptionSettings({ enabled: true, apiKey: replace(OWN_KEY) }, { env, now: NOW });
  await saveLlmSettings(llmWithGroq({ enabled: false }), { env });
  const view = await readTranscriptionView(env);
  assert.deepEqual([view.key, view.llmKey, view.ownKey], ["llm", true, true]);
  const engine = await transcriptionEngineEnv({}, env, { log: () => {} });
  assert.equal(engine[GROQ_KEY_ENV], LLM_KEY);
});

test("a Groq key of Pengaturan AI that goes to another server is not reused", async (t) => {
  const { env } = await sandbox(t);
  await saveLlmSettings(llmWithGroq({ baseUrl: "https://proxy.example/openai/v1" }), { env });
  await saveTranscriptionSettings({ enabled: true }, { env, now: NOW });
  const view = await readTranscriptionView(env);
  assert.deepEqual([view.key, view.llmKey], ["missing", false]);
  const engine = await transcriptionEngineEnv({}, env, { log: () => {} });
  assert.equal(engine[GROQ_KEY_ENV], undefined);
});

test("without a settings file, a Groq provider from the environment lends its key", async (t) => {
  const { env } = await sandbox(t, { POTONGIN_LLM_PROVIDERS: "groq", GROQ_API_KEY: LLM_KEY });
  await saveTranscriptionSettings({ enabled: true }, { env, now: NOW });
  assert.equal((await readTranscriptionView(env)).key, "llm");
  assert.equal((await transcriptionEngineEnv({}, env, { log: () => {} }))[GROQ_KEY_ENV], LLM_KEY);
});

test("a key sealed under another secret is unreadable and never guessed; a broken file is corrupt", async (t) => {
  const { env, settings } = await sandbox(t);
  await saveTranscriptionSettings({ enabled: true, apiKey: replace(OWN_KEY) }, { env, now: NOW });
  const rotated = { ...env, APP_SESSION_SECRET: "another-session-".padEnd(48, "r") };
  const view = await readTranscriptionView(rotated);
  assert.deepEqual([view.key, view.ownKey, view.enabled], ["unreadable", true, true]);

  await writeFile(path.join(settings, TRANSCRIPTION_FILE), "{bukan json");
  const broken = await readTranscriptionView(env);
  assert.deepEqual([broken.problem, broken.enabled, broken.key], ["corrupt", false, "missing"]);
  // Saving again overwrites a broken file.
  const saved = await saveTranscriptionSettings({ enabled: true, apiKey: replace(OWN_KEY) }, { env, now: NOW });
  assert.deepEqual([saved.problem, saved.key], [null, "own"]);
});

test("invalid input is refused with fixed messages that never echo a key", async (t) => {
  const { env } = await sandbox(t);
  for (const input of [
    null, [], "on", {}, { enabled: "yes" }, { enabled: true, extra: 1 },
    { enabled: true, apiKey: "plain" }, { enabled: true, apiKey: { action: "replace" } },
    { enabled: true, apiKey: { action: "replace", value: "dua kata" } }, { enabled: true, apiKey: { action: "copy" } },
    { enabled: true, apiKey: { action: "keep", value: OWN_KEY } },
  ]) {
    await assert.rejects(saveTranscriptionSettings(input, { env }), (error) => {
      assert.ok(error instanceof TranscriptionSettingsError, JSON.stringify(input));
      assert.equal(error.code, "invalid");
      assert.ok(!error.message.includes(OWN_KEY) && !error.message.includes("dua kata"));
      return true;
    });
  }
});

test("without a usable secret a key cannot be saved, but the switch alone can", async (t) => {
  const { env } = await sandbox(t, { APP_SESSION_SECRET: "", POTONGIN_SETTINGS_SECRET: "" });
  await assert.rejects(saveTranscriptionSettings({ enabled: true, apiKey: replace(OWN_KEY) }, { env }), { code: "secret_missing" });
  const view = await saveTranscriptionSettings({ enabled: true }, { env, now: NOW });
  assert.deepEqual([view.enabled, view.key, view.secretConfigured], [true, "missing", false]);
});

// --- The engine's environment ---------------------------------------------------------------

test("off, the engine gets no Groq variable, not even inherited ones", async (t) => {
  const { env } = await sandbox(t);
  const inherited = { PATH: "/usr/bin", [GROQ_SWITCH_ENV]: "on", [GROQ_KEY_ENV]: "inherited-groq-key" };
  assert.deepEqual(await transcriptionEngineEnv(inherited, env, { log: () => {} }), { PATH: "/usr/bin" });
  await saveTranscriptionSettings({ enabled: false, apiKey: replace(OWN_KEY) }, { env, now: NOW });
  assert.deepEqual(await transcriptionEngineEnv(inherited, env, { log: () => {} }), { PATH: "/usr/bin" });
});

test("on, the engine gets the switch and the key; without a key only the switch and a log line", async (t) => {
  const { env } = await sandbox(t);
  await saveTranscriptionSettings({ enabled: true, apiKey: replace(OWN_KEY) }, { env, now: NOW });
  const logs = [];
  const engine = await transcriptionEngineEnv({ PATH: "/usr/bin" }, env, { log: (line) => logs.push(line) });
  assert.deepEqual(engine, { PATH: "/usr/bin", [GROQ_SWITCH_ENV]: "on", [GROQ_KEY_ENV]: OWN_KEY });
  assert.deepEqual(logs, []);

  await saveTranscriptionSettings({ enabled: true, apiKey: { action: "clear" } }, { env, now: NOW });
  const keyless = await transcriptionEngineEnv({ PATH: "/usr/bin" }, env, { log: (line) => logs.push(line) });
  assert.deepEqual(keyless, { PATH: "/usr/bin", [GROQ_SWITCH_ENV]: "on" });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /Groq/);
});

test("an unreadable store or key leaves Groq off or keyless and says why without the key", async (t) => {
  const { env, settings } = await sandbox(t);
  await saveTranscriptionSettings({ enabled: true, apiKey: replace(OWN_KEY) }, { env, now: NOW });
  const logs = [];
  const rotated = { ...env, APP_SESSION_SECRET: "another-session-".padEnd(48, "r") };
  const keyless = await transcriptionEngineEnv({}, rotated, { log: (line) => logs.push(line) });
  assert.deepEqual(keyless, { [GROQ_SWITCH_ENV]: "on" });

  await writeFile(path.join(settings, TRANSCRIPTION_FILE), "{bukan json");
  assert.deepEqual(await transcriptionEngineEnv({}, env, { log: (line) => logs.push(line) }), {});
  assert.equal(logs.length, 2);
  for (const line of logs) assert.ok(!line.includes(OWN_KEY));
});

// --- Route ----------------------------------------------------------------------------------

function authorize(request) {
  return isAuthorized(request, AUTH) ? null
    : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function request(method, { body, origin = "http://local", cookie = true, contentType = "application/json" } = {}) {
  const headers = { Host: "local" };
  if (origin) headers.Origin = origin;
  if (cookie) headers.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  if (body !== undefined && contentType) headers["Content-Type"] = contentType;
  return new Request("http://local/api/settings/transcription", {
    method, headers, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function read(response) {
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null, cacheControl: response.headers.get("cache-control") };
}

test("the route needs a session for both methods and the same origin for a change", async (t) => {
  const { env } = await sandbox(t);
  for (const method of ["GET", "PUT"]) {
    const answer = await read(await transcriptionRouteModule[method](request(method, { cookie: false, body: method === "PUT" ? { enabled: true } : undefined })));
    assert.equal(answer.status, 401, method);
    assert.equal(answer.cacheControl, "no-store", method);
  }
  const route = createTranscriptionSettingsRoute({ authorize, env });
  for (const origin of ["https://evil.example", null]) {
    assert.equal((await route.PUT(request("PUT", { body: { enabled: true }, origin }))).status, 403);
  }
  assert.equal((await readTranscriptionView(env)).enabled, false);
});

test("saving and reading through the route never returns a key", async (t) => {
  const { env } = await sandbox(t);
  const route = createTranscriptionSettingsRoute({ authorize, env, now: () => NOW });
  const first = await read(await route.GET(request("GET")));
  assert.equal(first.status, 200);
  assert.equal(first.body.enabled, false);

  const saved = await read(await route.PUT(request("PUT", { body: { enabled: true, apiKey: replace(OWN_KEY) } })));
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.cacheControl, "no-store");
  assert.deepEqual(saved.body, {
    enabled: true, key: "own", ownKey: true, llmKey: false, secretConfigured: true, updatedAt: NOW.toISOString(), problem: null,
  });
  const again = await read(await route.GET(request("GET")));
  for (const answer of [saved, again]) assert.ok(!answer.text.includes(OWN_KEY));
});

test("a refused change answers with its code and keeps what was stored", async (t) => {
  const { env } = await sandbox(t);
  const route = createTranscriptionSettingsRoute({ authorize, env, now: () => NOW });
  await route.PUT(request("PUT", { body: { enabled: true, apiKey: replace(OWN_KEY) } }));

  const invalid = await read(await route.PUT(request("PUT", { body: { enabled: true, apiKey: replace("dua kata") } })));
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.code, "invalid");
  assert.ok(!invalid.text.includes("dua kata"));
  assert.equal((await route.PUT(request("PUT", { body: "{bukan json" }))).status, 400);
  assert.equal((await route.PUT(request("PUT", { body: { enabled: true }, contentType: "text/plain" }))).status, 415);
  assert.equal((await route.PUT(request("PUT", { body: { enabled: true, apiKey: replace("x".repeat(9000)) } }))).status, 413);
  assert.equal((await readTranscriptionView(env)).key, "own");
});

// --- The card's view model --------------------------------------------------------------------

test("the card keeps only known state fields", () => {
  assert.deepEqual(transcriptionState(null), {
    enabled: false, key: "missing", ownKey: false, llmKey: false, secretConfigured: false, updatedAt: null, problem: null,
  });
  assert.deepEqual(transcriptionState({
    enabled: true, key: "llm", ownKey: true, llmKey: true, secretConfigured: true, updatedAt: NOW.toISOString(), problem: null, apiKey: OWN_KEY,
  }), { enabled: true, key: "llm", ownKey: true, llmKey: true, secretConfigured: true, updatedAt: NOW.toISOString(), problem: null });
  const odd = transcriptionState({ enabled: "yes", key: "stolen", updatedAt: "kemarin", problem: "boom" });
  assert.deepEqual([odd.enabled, odd.key, odd.updatedAt, odd.problem], [false, "missing", null, null]);
});

test("the card says plainly that the audio goes to Groq and when local Whisper is used", () => {
  // The tab's words are in the catalog now (rombak 07 §8.3).
  const copy = loadNamespace("id", "settings").transcription;
  assert.match(copy.privacy, /Groq/);
  assert.match(copy.privacy, /pihak ketiga/);
  assert.match(copy.privacy, /Whisper/);
  assert.equal(copy.groq, "Transkrip lewat Groq");
  assert.equal(copy.key, "API key Groq");
  assert.equal(GROQ_KEY_URL, "https://console.groq.com/keys");
  const strings = (node) => (typeof node === "string" ? [node] : Object.values(node).flatMap(strings));
  for (const code of ["id", "en"]) {
    for (const text of strings(loadNamespace(code, "settings").transcription)) {
      assert.ok(!/—/.test(text), "no em dash");
      assert.ok(!/\bV\d\b|\bbaru\b|\bnew\b/i.test(text), `no version or 'new' wording: ${text}`);
    }
  }
});

test("the card warns about a missing, unreadable or unsavable key", () => {
  const base = transcriptionState({ secretConfigured: true });
  assert.equal(transcriptionNotice(base), null, "off and keyless needs no warning");
  assert.equal(transcriptionNotice({ ...base, enabled: true, key: "llm", llmKey: true }), null);
  assert.equal(transcriptionNotice({ ...base, enabled: true }).tone, "warning");
  assert.equal(transcriptionNotice({ ...base, key: "unreadable", ownKey: true }).tone, "error");
  assert.equal(transcriptionNotice({ ...base, secretConfigured: false }).tone, "error");
  assert.equal(transcriptionNotice({ ...base, problem: "corrupt" }).tone, "error");
  assert.deepEqual(transcriptionNotice({ ...base, key: "unreadable", ownKey: true }), { tone: "error", key: "transcription.notice.unreadable" });
  assert.equal(settingsText(transcriptionNotice({ ...base, key: "unreadable", ownKey: true })), "API key Groq tersimpan tidak bisa dibuka. Isi ulang.");
  assert.equal(settingsText(transcriptionNotice({ ...base, enabled: true })), "Isi API key Groq. Tanpa key, Whisper di server ini yang dipakai.");
  assert.match(settingsText(transcriptionNotice({ ...base, secretConfigured: false })), /Kunci enkripsi pengaturan belum tersedia/);
});

test("the card names what the next job uses after a save, and each refusal", () => {
  const text = (descriptor) => settingsText(descriptor);
  assert.match(text(transcriptionSavedMessage({ enabled: true, key: "own" })), /Groq/);
  assert.match(text(transcriptionSavedMessage({ enabled: false, key: "own" })), /Whisper/);
  assert.equal(text(transcriptionSavedMessage({ enabled: true, key: "missing" })), "Tersimpan. Isi API key Groq supaya Groq bisa dipakai.");
  assert.match(text(transcriptionErrorMessage({ status: 401 })), /Sesi login/);
  assert.match(text(transcriptionErrorMessage({ status: 0 })), /Koneksi/);
  // The server's own words for a refused value are shown as they are.
  assert.deepEqual(transcriptionErrorMessage({ status: 422, code: "invalid", error: "API key harus berupa teks ASCII tanpa spasi." }), { text: "API key harus berupa teks ASCII tanpa spasi." });
  assert.match(text(transcriptionErrorMessage({ status: 503, code: "secret_missing" })), /enkripsi/);
  assert.match(text(transcriptionErrorMessage({ status: 500, code: "whatever" })), /gagal/);
});
