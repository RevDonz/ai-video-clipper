import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  LLM_PRESETS,
  PROVIDER_NAMES,
  baseUrlProblem,
  isBlockedAddress,
  scopedEnvName,
} from "../lib/llm-presets.mjs";
import {
  LlmSettingsError,
  buildLlmEnv,
  decryptApiKey,
  encryptApiKey,
  engineProcessEnv,
  hasLlmEnv,
  importEnvToFile,
  importFromEnv,
  loadLlmEnv,
  normalizeSettingsInput,
  publicSettingsView,
  readEffectiveLlmStatus,
  readLlmSettings,
  readLlmSettingsView,
  resolveSettingsPaths,
  saveLlmSettings,
  settingsSecret,
} from "../lib/llm-settings.mjs";
import { readLlmStatus } from "../lib/llm-status.mjs";

const run = promisify(execFile);
const SECRET = "settings-secret-".padEnd(48, "x");
const OTHER_SECRET = "another-secret-".padEnd(48, "y");
const KEYS = Object.freeze({
  custom: "hermes-key-AAAA1111zz",
  "ollama-cloud": "ollama-cloud-key-BBBB2222",
  openrouter: "sk-or-v1-CCCC3333dddd",
  gemini: "AIzaGEMINIkeyDDDD4444",
});

function pythonBin() {
  return process.env.PYTHON_BIN || "../.venv/bin/python";
}

async function sandbox(extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-settings-"));
  const env = { JOBS_ROOT: path.join(root, "jobs"), APP_SESSION_SECRET: SECRET, ...extra };
  return { root, env, dir: path.join(root, "settings"), file: path.join(root, "settings", "llm-settings.json") };
}

function hermesInput(overrides = {}) {
  return {
    enabled: true,
    freeOnly: true,
    providers: [
      {
        provider: "custom", enabled: true, baseUrl: "https://hermes.example/v1", model: "LJNAI-FAST",
        reasoningEffort: "none", contextTokens: 65536, maxOutputTokens: 16384, timeout: 600,
        apiKey: { action: "replace", value: KEYS.custom },
      },
      { provider: "ollama-cloud", enabled: true, apiKey: { action: "replace", value: KEYS["ollama-cloud"] } },
      { provider: "openrouter", enabled: true, fallbackModels: ["openrouter/free"], apiKey: { action: "replace", value: KEYS.openrouter } },
      { provider: "gemini", enabled: true },
    ],
    ...overrides,
  };
}

function assertNoSecrets(text, label = "output") {
  for (const key of Object.values(KEYS)) assert.ok(!text.includes(key), `${label} must not contain an API key`);
  assert.ok(!text.includes(SECRET), `${label} must not contain the settings secret`);
}

function invalid(fn, field) {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  assert.ok(caught instanceof LlmSettingsError, `expected LlmSettingsError for ${field}`);
  assert.equal(caught.code, "invalid");
  assert.ok(caught.issues.some((issue) => issue.field === field), `${field} not in ${JSON.stringify(caught.issues)}`);
  return caught;
}

// --- Paths and presets ---------------------------------------------------------------

test("settings live beside JOBS_ROOT (outside it) or at an absolute POTONGIN_SETTINGS_DIR", () => {
  assert.deepEqual(resolveSettingsPaths({ JOBS_ROOT: "/data/jobs" }), { dir: "/data/settings", file: "/data/settings/llm-settings.json" });
  assert.deepEqual(resolveSettingsPaths({}), { dir: "/data/settings", file: "/data/settings/llm-settings.json" });
  assert.equal(resolveSettingsPaths({ JOBS_ROOT: "/data/jobs", POTONGIN_SETTINGS_DIR: "/srv/potongin" }).dir, "/srv/potongin");
  assert.throws(() => resolveSettingsPaths({ POTONGIN_SETTINGS_DIR: "relative/dir" }), LlmSettingsError);
  assert.throws(() => resolveSettingsPaths({ JOBS_ROOT: "/data/jobs", POTONGIN_SETTINGS_DIR: "/data/jobs/settings" }), LlmSettingsError);
  assert.throws(() => resolveSettingsPaths({ JOBS_ROOT: "/data/jobs", POTONGIN_SETTINGS_DIR: "/data/jobs" }), LlmSettingsError);
});

test("the settings secret prefers POTONGIN_SETTINGS_SECRET and needs 32 characters", () => {
  assert.equal(settingsSecret({ APP_SESSION_SECRET: SECRET }), SECRET);
  assert.equal(settingsSecret({ APP_SESSION_SECRET: SECRET, POTONGIN_SETTINGS_SECRET: OTHER_SECRET }), OTHER_SECRET);
  assert.equal(settingsSecret({ APP_SESSION_SECRET: "short" }), null);
  assert.equal(settingsSecret({ POTONGIN_SETTINGS_SECRET: "short", APP_SESSION_SECRET: SECRET }), null, "a bad explicit secret is not silently replaced");
  assert.equal(settingsSecret({}), null);
  assert.equal(settingsSecret({ APP_SESSION_SECRET: "generate-a-random-secret-with-at-least-32-characters" }), null, "the public .env.example value protects nothing");
});

test("base URL rules mirror the engine and refuse link-local and metadata hosts", () => {
  for (const url of [
    "https://api.example.com/v1", "https://ollama.com/v1", "http://localhost:11434/v1", "http://127.0.0.1:8000/v1",
    "http://[::1]:11434/v1", "http://host.docker.internal:1234/v1", "https://10.0.0.5:8443/v1", "https://my_service/v1",
    "https://generativelanguage.googleapis.com/v1beta/openai", "https://api.deepseek.com",
  ]) assert.equal(baseUrlProblem(url), null, url);
  for (const url of [
    "", "   ", "https://api.example.com /v1", "ftp://files.example", "http://remote.example/v1", "https://user:pass@x.example/v1",
    "https://x.example/v1?a=1", "https://x.example/v1#frag", "https:///v1", "https://169.254.169.254/latest", "http://169.254.169.254/",
    "https://[fd00:ec2::254]/", "https://[::ffff:169.254.169.254]/", "https://[fe80::1]/", "https://metadata.google.internal/computeMetadata/v1",
    "https://2852039166/", "http://127.1:11434/v1", "https://100.100.100.200/", "https://x.example\\@evil/v1", "javascript:alert(1)",
    `https://${"a".repeat(2100)}.example/v1`,
  ]) assert.notEqual(baseUrlProblem(url), null, url);
  assert.equal(isBlockedAddress("169.254.10.1"), true);
  assert.equal(isBlockedAddress("::ffff:a9fe:a9fe"), true);
  assert.equal(isBlockedAddress("64:ff9b::a9fe:a9fe"), true);
  assert.equal(isBlockedAddress("fd00:ec2::254"), true);
  assert.equal(isBlockedAddress("fe80::abcd"), true);
  assert.equal(isBlockedAddress("8.8.8.8"), false);
  assert.equal(isBlockedAddress("::1"), false);
  assert.equal(isBlockedAddress("2001:db8::1"), false);
});

test("provider presets mirror the engine's --show-presets output", async () => {
  const { stdout } = await run(pythonBin(), ["-m", "ai_clipper.llm", "--show-presets", "--json"], { env: { PATH: process.env.PATH } });
  const engine = JSON.parse(stdout);
  assert.deepEqual(Object.keys(engine), [...PROVIDER_NAMES]);
  for (const name of PROVIDER_NAMES) {
    const ours = LLM_PRESETS[name];
    const theirs = engine[name];
    assert.deepEqual({
      baseUrl: ours.baseUrl, defaultModel: ours.defaultModel, fallbackModels: [...ours.fallbackModels], keyEnv: [...ours.keyEnv],
      requiresKey: ours.requiresKey, contextTokens: ours.contextTokens, maxOutputTokens: ours.maxOutputTokens, timeout: ours.timeout, rpm: ours.rpm,
    }, {
      baseUrl: theirs.base_url, defaultModel: theirs.default_model, fallbackModels: theirs.fallback_models, keyEnv: theirs.key_env,
      requiresKey: theirs.requires_key, contextTokens: theirs.context_tokens, maxOutputTokens: theirs.max_output_tokens, timeout: theirs.timeout,
      rpm: theirs.requests_per_minute,
    }, `preset ${name} drifted from src/ai_clipper/llm.py`);
    assert.match(ours.description, /\S/);
  }
  assert.equal(scopedEnvName("ollama-cloud", "API_KEY"), "POTONGIN_LLM_OLLAMA_CLOUD_API_KEY");
});

// --- Validation -------------------------------------------------------------------------

test("saving validates every value strictly and never echoes the rejected value", () => {
  const base = hermesInput();
  const stored = normalizeSettingsInput(base, { secret: SECRET, now: new Date("2026-09-24T10:00:00Z") });
  assert.equal(stored.version, 1);
  assert.equal(stored.updatedAt, "2026-09-24T10:00:00.000Z");
  assert.deepEqual(stored.providers.map((item) => item.provider), ["custom", "ollama-cloud", "openrouter", "gemini"]);
  assert.equal(stored.providers[0].reasoningEffort, "none");
  assert.equal(stored.providers[3].apiKey, undefined);
  assertNoSecrets(JSON.stringify(stored), "stored document");

  const withProvider = (index, patch) => {
    const copy = structuredClone(base);
    copy.providers[index] = { ...copy.providers[index], ...patch };
    return copy;
  };
  const cases = [
    [{ ...base, providers: "custom" }, "providers"],
    [{ ...base, enabled: "true" }, "enabled"],
    [{ ...base, freeOnly: 1 }, "freeOnly"],
    [{ ...base, surprise: true }, "surprise"],
    [{ ...base, providers: [...base.providers, { provider: "gemini", enabled: false }] }, "providers[4].provider"],
    [withProvider(1, { provider: "nope-provider" }), "providers[1].provider"],
    [withProvider(1, { enabled: "yes" }), "providers[1].enabled"],
    [withProvider(0, { baseUrl: undefined }), "providers[0].baseUrl"],
    [withProvider(0, { model: "" }), "providers[0].model"],
    [withProvider(0, { baseUrl: "http://remote-secret-host.example/v1" }), "providers[0].baseUrl"],
    [withProvider(0, { baseUrl: "https://169.254.169.254/v1" }), "providers[0].baseUrl"],
    [withProvider(1, { model: "model with space" }), "providers[1].model"],
    [withProvider(2, { fallbackModels: ["ok-model", "bad model-secret"] }), "providers[2].fallbackModels"],
    [withProvider(2, { fallbackModels: "a,b" }), "providers[2].fallbackModels"],
    [withProvider(2, { fallbackModels: ["none"] }), "providers[2].fallbackModels"],
    [withProvider(0, { reasoningEffort: "turbo" }), "providers[0].reasoningEffort"],
    [withProvider(0, { contextTokens: 100 }), "providers[0].contextTokens"],
    [withProvider(0, { contextTokens: 65536.5 }), "providers[0].contextTokens"],
    [withProvider(0, { contextTokens: "65536" }), "providers[0].contextTokens"],
    [withProvider(0, { timeout: 0 }), "providers[0].timeout"],
    [withProvider(0, { timeout: 3601 }), "providers[0].timeout"],
    [withProvider(0, { temperature: 3 }), "providers[0].temperature"],
    [withProvider(0, { maxRetries: 11 }), "providers[0].maxRetries"],
    [withProvider(0, { rpm: -1 }), "providers[0].rpm"],
    [withProvider(0, { jsonMode: "false" }), "providers[0].jsonMode"],
    [withProvider(2, { httpReferer: "not a url" }), "providers[2].httpReferer"],
    [withProvider(0, { surprise: 1 }), "providers[0].surprise"],
    [withProvider(0, { apiKey: { action: "replace", value: "key with-secret space" } }), "providers[0].apiKey"],
    [withProvider(0, { apiKey: { action: "replace" } }), "providers[0].apiKey"],
    [withProvider(0, { apiKey: { action: "explode" } }), "providers[0].apiKey"],
    [withProvider(0, { apiKey: "raw-key-string" }), "providers[0].apiKey"],
  ];
  for (const [input, field] of cases) {
    const error = invalid(() => normalizeSettingsInput(input, { secret: SECRET }), field);
    const text = JSON.stringify({ message: error.message, issues: error.issues });
    assert.doesNotMatch(text, /remote-secret-host|with-secret|bad model-secret|raw-key-string|model with space/);
  }
  assert.throws(() => normalizeSettingsInput(null, { secret: SECRET }), LlmSettingsError);
  assert.throws(() => normalizeSettingsInput([], { secret: SECRET }), LlmSettingsError);

  // A disabled custom provider may be incomplete: it is never handed to the engine.
  const draft = normalizeSettingsInput({ enabled: true, freeOnly: false, providers: [{ provider: "custom", enabled: false }] }, { secret: SECRET });
  assert.deepEqual(draft.providers, [{ provider: "custom", enabled: false }]);
  // Blank strings and nulls mean "use the preset default".
  const blank = normalizeSettingsInput({ enabled: true, freeOnly: false, providers: [{ provider: "groq", enabled: true, model: "  ", timeout: null, baseUrl: "" }] }, { secret: SECRET });
  assert.deepEqual(blank.providers, [{ provider: "groq", enabled: true }]);
  // Keys are trimmed like the engine trims environment values.
  const trimmed = normalizeSettingsInput({ enabled: true, freeOnly: false, providers: [{ provider: "groq", enabled: true, apiKey: { action: "replace", value: `  ${KEYS.gemini}\n` } }] }, { secret: SECRET });
  assert.equal(decryptApiKey(trimmed.providers[0].apiKey, "groq", SECRET), KEYS.gemini);
});

// --- Encryption --------------------------------------------------------------------------

test("API keys are sealed with AES-256-GCM and bound to their provider", () => {
  const box = encryptApiKey(KEYS.custom, "custom", SECRET);
  assert.deepEqual(Object.keys(box).sort(), ["ciphertext", "iv", "tag"]);
  assert.equal(Buffer.from(box.iv, "base64").length, 12);
  assert.equal(Buffer.from(box.tag, "base64").length, 16);
  assertNoSecrets(JSON.stringify(box), "sealed key");
  assert.equal(decryptApiKey(box, "custom", SECRET), KEYS.custom);
  assert.equal(decryptApiKey(box, "custom", OTHER_SECRET), null, "wrong secret");
  assert.equal(decryptApiKey(box, "groq", SECRET), null, "moved to another provider");
  const tampered = { ...box, ciphertext: Buffer.from(Buffer.from(box.ciphertext, "base64").map((byte, index) => (index === 0 ? byte ^ 1 : byte))).toString("base64") };
  assert.equal(decryptApiKey(tampered, "custom", SECRET), null, "tampered");
  assert.equal(decryptApiKey(box, "custom", null), null, "no secret");
  assert.notDeepEqual(encryptApiKey(KEYS.custom, "custom", SECRET).iv, box.iv, "fresh IV per seal");
});

// --- Store -------------------------------------------------------------------------------

test("saving writes a 0600 file in a 0700 directory atomically and reads it back strictly", async () => {
  const { env, dir, file } = await sandbox();
  assert.deepEqual(await readLlmSettings({ env }), { exists: false, settings: null, file });
  const saved = await saveLlmSettings(hermesInput(), { env });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dir), ["llm-settings.json"], "no temporary files left behind");
  const raw = await readFile(file, "utf8");
  assertNoSecrets(raw, "settings file");
  assert.equal(JSON.parse(raw).version, 1);
  const read = await readLlmSettings({ env });
  assert.equal(read.exists, true);
  assert.deepEqual(read.settings, saved);

  // A pre-existing, too-open directory is tightened.
  const loose = await sandbox();
  await mkdir(loose.dir, { mode: 0o755 });
  await chmod(loose.dir, 0o755);
  await saveLlmSettings(hermesInput(), { env: loose.env });
  assert.equal((await stat(loose.dir)).mode & 0o777, 0o700);
});

test("a corrupt, oversized, symlinked or future-version file is refused, not guessed", async () => {
  for (const [label, prepare] of [
    ["not json", (file) => writeFile(file, "{ nope")],
    ["wrong version", (file) => writeFile(file, JSON.stringify({ version: 2, enabled: true, freeOnly: false, providers: [], updatedAt: "2026-09-24T00:00:00.000Z" }))],
    ["bad provider", (file) => writeFile(file, JSON.stringify({ version: 1, enabled: true, freeOnly: false, providers: [{ provider: "evil", enabled: true }], updatedAt: "2026-09-24T00:00:00.000Z" }))],
    ["plaintext key", (file) => writeFile(file, JSON.stringify({ version: 1, enabled: true, freeOnly: false, providers: [{ provider: "groq", enabled: true, apiKey: { value: "plain" } }], updatedAt: "2026-09-24T00:00:00.000Z" }))],
    ["oversized", (file) => writeFile(file, " ".repeat(300 * 1024))],
    ["symlink", async (file) => { await writeFile(`${file}.real`, "{}"); await symlink(`${file}.real`, file); }],
  ]) {
    const { env, dir, file } = await sandbox();
    await mkdir(dir, { recursive: true });
    await prepare(file);
    await assert.rejects(readLlmSettings({ env }), (error) => error instanceof LlmSettingsError && error.code === "corrupt", label);
  }
});

test("keep, replace and clear update keys; stale edits and a missing secret are refused", async () => {
  const { env } = await sandbox();
  const first = await saveLlmSettings(hermesInput(), { env });
  const keep = hermesInput({ baseUpdatedAt: first.updatedAt });
  keep.providers = keep.providers.map((item) => ({ ...item, apiKey: item.provider === "openrouter" ? { action: "clear" } : { action: "keep" } }));
  keep.providers.push({ provider: "groq", enabled: true, apiKey: { action: "keep" } });
  const second = await saveLlmSettings(keep, { env, now: new Date(Date.parse(first.updatedAt) + 1000) });
  assert.deepEqual(second.providers[0].apiKey, first.providers[0].apiKey, "keep reuses the sealed key");
  assert.equal(second.providers[2].apiKey, undefined, "clear removes it");
  assert.equal(second.providers[4].apiKey, undefined, "keep without a stored key stays empty");

  await assert.rejects(saveLlmSettings(hermesInput({ baseUpdatedAt: first.updatedAt }), { env }), (error) => error.code === "conflict");
  await assert.rejects(saveLlmSettings(hermesInput({ baseUpdatedAt: null }), { env }), (error) => error.code === "conflict");

  const noSecret = await sandbox({ APP_SESSION_SECRET: "" });
  await assert.rejects(saveLlmSettings(hermesInput(), { env: noSecret.env }), (error) => error.code === "secret_missing");
  // Without keys, a secret is not needed.
  await saveLlmSettings({ enabled: true, freeOnly: false, providers: [{ provider: "ollama", enabled: true }] }, { env: noSecret.env });

  // After the secret changes, the key shows as stored but unreadable.
  const view = publicSettingsView(second, { secret: OTHER_SECRET, source: "ui" });
  assert.deepEqual(view.providers[0], {
    provider: "custom", enabled: true, baseUrl: "https://hermes.example/v1", model: "LJNAI-FAST", reasoningEffort: "none",
    contextTokens: 65536, maxOutputTokens: 16384, timeout: 600, apiKeySet: true, apiKeyUnreadable: true, source: "ui",
  });
  assert.equal(publicSettingsView(second, { secret: SECRET, source: "ui" }).providers[0].apiKeyUnreadable, false);
  assertNoSecrets(JSON.stringify(view), "public view");
});

test("a kept key never follows the base URL to another server: a new host needs the key again", async () => {
  const { env } = await sandbox();
  const first = await saveLlmSettings(hermesInput(), { env });
  const keepAll = (mutate) => {
    const input = hermesInput({ baseUpdatedAt: first.updatedAt });
    input.providers = input.providers.map((item) => ({ ...item, apiKey: { action: "keep" } }));
    mutate(input.providers);
    return input;
  };
  const refusedKey = (index) => (error) => error instanceof LlmSettingsError && error.code === "invalid"
    && error.issues.some((issue) => issue.field === `providers[${index}].apiKey` && /isi ulang/i.test(issue.message));

  // Repointing Hermes (custom) or a preset (openrouter, whose default URL is implicit) while keeping its key.
  await assert.rejects(saveLlmSettings(keepAll((list) => { list[0].baseUrl = "https://collector.example/v1"; }), { env }), refusedKey(0));
  await assert.rejects(saveLlmSettings(keepAll((list) => { list[2].baseUrl = "https://collector.example/api/v1"; }), { env }), refusedKey(2));
  await assert.rejects(saveLlmSettings(keepAll((list) => { list[0].baseUrl = "https://hermes.example:8443/v1"; }), { env }), refusedKey(0));
  const unchanged = await readLlmSettings({ env });
  assert.equal(unchanged.settings.updatedAt, first.updatedAt, "a refused save writes nothing");

  // Same server, another path; or the preset URL written out explicitly: the key stays.
  const samePlace = await saveLlmSettings(keepAll((list) => {
    list[0].baseUrl = "https://hermes.example/openai/v1";
    list[2].baseUrl = "https://openrouter.ai/api/v1";
  }), { env });
  assert.deepEqual(samePlace.providers[0].apiKey, first.providers[0].apiKey);
  assert.deepEqual(samePlace.providers[2].apiKey, first.providers[2].apiKey);

  // A new host with a freshly entered key (or no key) is fine.
  const moved = hermesInput({ baseUpdatedAt: samePlace.updatedAt });
  moved.providers[0] = { ...moved.providers[0], baseUrl: "https://hermes-new.example/v1", apiKey: { action: "replace", value: "hermes-key-NEW9999" } };
  moved.providers[2] = { ...moved.providers[2], baseUrl: "https://collector.example/api/v1", apiKey: { action: "clear" } };
  const saved = await saveLlmSettings(moved, { env });
  assert.equal(decryptApiKey(saved.providers[0].apiKey, "custom", SECRET), "hermes-key-NEW9999");
  assert.equal(saved.providers[2].apiKey, undefined);

  // The first save from the environment follows the same rule for the environment's keys.
  const fromEnv = await sandbox({ POTONGIN_LLM_PROVIDERS: "openrouter", OPENROUTER_API_KEY: KEYS.openrouter });
  await assert.rejects(saveLlmSettings({
    baseUpdatedAt: null, enabled: true, freeOnly: true,
    providers: [{ provider: "openrouter", enabled: true, baseUrl: "https://collector.example/v1", apiKey: { action: "keep" } }],
  }, { env: fromEnv.env }), refusedKey(0));
});

test("the first save without a file keeps the keys the server environment already has", async () => {
  const { env } = await sandbox({ POTONGIN_LLM_PROVIDERS: "ollama-cloud,openrouter", OLLAMA_API_KEY: KEYS["ollama-cloud"] });
  const saved = await saveLlmSettings({
    baseUpdatedAt: null, enabled: true, freeOnly: true,
    providers: [{ provider: "ollama-cloud", enabled: true, apiKey: { action: "keep" } }, { provider: "openrouter", enabled: true }],
  }, { env });
  assert.equal(decryptApiKey(saved.providers[0].apiKey, "ollama-cloud", SECRET), KEYS["ollama-cloud"]);
  assert.equal(saved.providers[1].apiKey, undefined);
});

// --- Environment overlay -----------------------------------------------------------------

test("buildLlmEnv replaces every inherited LLM variable with the saved chain", () => {
  const settings = normalizeSettingsInput({
    enabled: true, freeOnly: true,
    providers: [
      { provider: "custom", enabled: true, baseUrl: "https://hermes.example/v1", model: "LJNAI-FAST", reasoningEffort: "none", contextTokens: 65536, timeout: 600, apiKey: { action: "replace", value: KEYS.custom } },
      { provider: "ollama-cloud", enabled: true, fallbackModels: [], temperature: 0.3, apiKey: { action: "replace", value: KEYS["ollama-cloud"] } },
      { provider: "openrouter", enabled: false, apiKey: { action: "replace", value: KEYS.openrouter } },
      { provider: "gemini", enabled: true, rpm: 0, jsonMode: false, maxRetries: 2 },
    ],
  }, { secret: SECRET });
  const base = Object.freeze({
    PATH: "/usr/bin", OTHER: "1", APP_SESSION_SECRET: SECRET, POTONGIN_LLM: "off", POTONGIN_LLM_PROVIDERS: "gemini", POTONGIN_LLM_MODEL: "inherited",
    POTONGIN_LLM_CUSTOM_BASE_URL: "https://old.example/v1", GEMINI_API_KEY: "inherited-gemini", GOOGLE_API_KEY: "inherited-google", OPENROUTER_API_KEY: "inherited-or",
    POTONGIN_LLM_PROVIDER: "groq",
  });
  const env = buildLlmEnv(settings, base);
  assert.deepEqual(env, {
    PATH: "/usr/bin", OTHER: "1", APP_SESSION_SECRET: SECRET,
    POTONGIN_LLM: "on",
    POTONGIN_LLM_PROVIDERS: "custom,ollama-cloud,gemini",
    POTONGIN_LLM_FREE_ONLY: "1",
    POTONGIN_LLM_CUSTOM_BASE_URL: "https://hermes.example/v1",
    POTONGIN_LLM_CUSTOM_MODEL: "LJNAI-FAST",
    POTONGIN_LLM_CUSTOM_REASONING_EFFORT: "none",
    POTONGIN_LLM_CUSTOM_CONTEXT_TOKENS: "65536",
    POTONGIN_LLM_CUSTOM_TIMEOUT: "600",
    POTONGIN_LLM_CUSTOM_API_KEY: KEYS.custom,
    POTONGIN_LLM_OLLAMA_CLOUD_FALLBACK_MODELS: "none",
    POTONGIN_LLM_OLLAMA_CLOUD_TEMPERATURE: "0.3",
    POTONGIN_LLM_OLLAMA_CLOUD_API_KEY: KEYS["ollama-cloud"],
    POTONGIN_LLM_GEMINI_RPM: "off",
    POTONGIN_LLM_GEMINI_MAX_RETRIES: "2",
    POTONGIN_LLM_GEMINI_JSON_MODE: "false",
  });
  assert.equal(base.GEMINI_API_KEY, "inherited-gemini", "the base env is not mutated");

  const disabled = buildLlmEnv({ ...settings, enabled: false }, base);
  assert.equal(disabled.POTONGIN_LLM, "off");
  assert.deepEqual(Object.keys(disabled).filter((name) => /POTONGIN_LLM|API_KEY/.test(name)), ["POTONGIN_LLM"]);

  const unchanged = buildLlmEnv(null, base);
  assert.deepEqual(unchanged, { ...base });
  assert.notEqual(unchanged, base);

  // The connection test runs exactly one provider, even a disabled one or with AI switched off.
  const only = buildLlmEnv({ ...settings, enabled: false }, base, { only: "openrouter" });
  assert.equal(only.POTONGIN_LLM_PROVIDERS, "openrouter");
  assert.equal(only.POTONGIN_LLM_OPENROUTER_API_KEY, KEYS.openrouter);
  assert.equal(only.POTONGIN_LLM, "on");
  assert.equal(only.POTONGIN_LLM_CUSTOM_API_KEY, undefined);

  // A provider whose sealed key cannot be opened (the secret changed) is left out of the chain.
  const rotated = buildLlmEnv(settings, { ...base, APP_SESSION_SECRET: OTHER_SECRET });
  assert.equal(rotated.POTONGIN_LLM_CUSTOM_API_KEY, undefined);
  assert.equal(rotated.POTONGIN_LLM_CUSTOM_BASE_URL, undefined);
  assert.equal(rotated.POTONGIN_LLM_PROVIDERS, "gemini");
});

test("engine child processes never receive dashboard credentials", () => {
  const env = engineProcessEnv({ PATH: "/bin", APP_USERNAME: "admin", APP_PASSWORD: "pw", APP_SESSION_SECRET: SECRET, POTONGIN_SETTINGS_SECRET: OTHER_SECRET, POTONGIN_LLM_CUSTOM_API_KEY: KEYS.custom });
  assert.deepEqual(env, { PATH: "/bin", APP_USERNAME: "admin", POTONGIN_LLM_CUSTOM_API_KEY: KEYS.custom });
});

test("loadLlmEnv falls back to the environment only when no settings file exists", async () => {
  const { env } = await sandbox({ GEMINI_API_KEY: "inherited", POTONGIN_LLM_PROVIDERS: "gemini" });
  assert.deepEqual(await loadLlmEnv(env), { env: { ...env }, source: "env", problem: null });
  await saveLlmSettings(hermesInput(), { env });
  const loaded = await loadLlmEnv(env);
  assert.equal(loaded.source, "ui");
  assert.equal(loaded.env.GEMINI_API_KEY, undefined);
  assert.equal(loaded.env.POTONGIN_LLM_PROVIDERS, "custom,ollama-cloud,openrouter,gemini");

  const broken = await sandbox({ GEMINI_API_KEY: "inherited", POTONGIN_LLM_PROVIDERS: "gemini" });
  await mkdir(broken.dir, { recursive: true });
  await writeFile(broken.file, "{");
  const safe = await loadLlmEnv(broken.env);
  assert.equal(safe.problem, "corrupt");
  assert.equal(safe.env.POTONGIN_LLM, "off", "a broken settings file switches the LLM off instead of silently using .env");
  assert.equal(safe.env.GEMINI_API_KEY, undefined);
});

// --- Import from the environment ---------------------------------------------------------

const OWNER_ENV = Object.freeze({
  POTONGIN_LLM_PROVIDERS: "custom, ollama_cloud,openrouter,gemini,groq,mystery,openrouter",
  POTONGIN_LLM_FREE_ONLY: "1",
  POTONGIN_LLM_CUSTOM_BASE_URL: "https://hermes.example/v1",
  POTONGIN_LLM_CUSTOM_API_KEY: KEYS.custom,
  POTONGIN_LLM_CUSTOM_MODEL: "LJNAI-FAST",
  POTONGIN_LLM_CUSTOM_REASONING_EFFORT: "NONE",
  POTONGIN_LLM_CUSTOM_CONTEXT_TOKENS: "65536",
  POTONGIN_LLM_CUSTOM_MAX_OUTPUT_TOKENS: "16384",
  POTONGIN_LLM_CUSTOM_TIMEOUT: "600",
  POTONGIN_LLM_MODEL: "shared-model-ignored-because-scoped-wins",
  POTONGIN_LLM_TEMPERATURE: "0.3",
  POTONGIN_LLM_RPM: "off",
  POTONGIN_LLM_OPENROUTER_FALLBACK_MODELS: "none",
  OLLAMA_API_KEY: KEYS["ollama-cloud"],
  OPENROUTER_API_KEY: KEYS.openrouter,
  GEMINI_API_KEY: "",
  GROQ_API_KEY: "  ",
});

test("importFromEnv resolves variables exactly like the engine", () => {
  const { settings, warnings } = importFromEnv(OWNER_ENV);
  assert.equal(settings.enabled, true);
  assert.equal(settings.freeOnly, true);
  assert.deepEqual(settings.providers.map((item) => item.provider), ["custom", "ollama-cloud", "openrouter", "gemini", "groq"]);
  assert.deepEqual(warnings, ["Penyedia 'mystery' tidak dikenal dan dilewati."]);
  const [custom, cloud, router, gemini, groq] = settings.providers;
  assert.deepEqual(custom, {
    provider: "custom", enabled: true, baseUrl: "https://hermes.example/v1", model: "LJNAI-FAST", reasoningEffort: "none",
    contextTokens: 65536, maxOutputTokens: 16384, timeout: 600, rpm: 0, temperature: 0.3, apiKey: { value: KEYS.custom },
  });
  assert.deepEqual(cloud, { provider: "ollama-cloud", enabled: true, rpm: 0, temperature: 0.3, apiKey: { value: KEYS["ollama-cloud"] } });
  assert.deepEqual(router.fallbackModels, []);
  assert.equal(gemini.apiKey, undefined);
  assert.equal(groq.apiKey, undefined);

  const single = importFromEnv({
    POTONGIN_LLM_PROVIDER: "gemini", POTONGIN_LLM_PROVIDERS: "groq", GOOGLE_API_KEY: "google-key", POTONGIN_LLM_BASE_URL: "https://proxy.example/v1",
  }).settings;
  assert.deepEqual(single.providers, [{ provider: "gemini", enabled: true, baseUrl: "https://proxy.example/v1", apiKey: { value: "google-key" } }]);
  const shared = importFromEnv({ POTONGIN_LLM_PROVIDERS: "gemini,groq", POTONGIN_LLM_API_KEY: "shared-key", GEMINI_API_KEY: "gemini-key", POTONGIN_LLM_MODEL: "m1" }).settings;
  assert.deepEqual(shared.providers[0].apiKey, { value: "shared-key" }, "the shared key wins for the first provider");
  assert.equal(shared.providers[0].model, "m1");
  assert.equal(shared.providers[1].apiKey, undefined, "and never reaches the others");
  assert.equal(shared.providers[1].model, undefined);
  assert.equal(importFromEnv({ ...OWNER_ENV, POTONGIN_LLM: "OFF" }).settings.enabled, false);
  assert.deepEqual(importFromEnv({}).settings, { enabled: true, freeOnly: false, providers: [] });

  for (const [name, value] of [
    ["POTONGIN_LLM_FREE_ONLY", "maybe"], ["POTONGIN_LLM_CUSTOM_TIMEOUT", "fast-secret"], ["POTONGIN_LLM_PROVIDERS", "gemini!"],
    ["POTONGIN_LLM_CUSTOM_BASE_URL", "http://remote-secret.example/v1"], ["POTONGIN_LLM_CUSTOM_MODEL", "has space-secret"],
    ["POTONGIN_LLM_CUSTOM_API_KEY", "key with-secret"], ["POTONGIN_LLM_CUSTOM_CONTEXT_TOKENS", "12.5"],
  ]) {
    let caught;
    try { importFromEnv({ ...OWNER_ENV, [name]: value }); } catch (error) { caught = error; }
    assert.ok(caught instanceof LlmSettingsError, `${name}=${value}`);
    assert.match(caught.message, new RegExp(name === "POTONGIN_LLM_CUSTOM_API_KEY" ? "API key" : name));
    assert.doesNotMatch(caught.message, /secret/);
  }
  assert.equal(hasLlmEnv({}), false);
  assert.equal(hasLlmEnv({ OLLAMA_API_KEY: "  ", POTONGIN_LLM: "" }), false);
  assert.equal(hasLlmEnv({ POTONGIN_LLM_PROVIDERS: "gemini" }), true);
  assert.equal(hasLlmEnv({ GROQ_API_KEY: "k" }), true);
});

test("an imported configuration gives the engine exactly the providers, models and keys it had", async () => {
  const { env } = await sandbox({ ...OWNER_ENV, PATH: process.env.PATH });
  await importEnvToFile({ env });
  await assert.rejects(importEnvToFile({ env }), (error) => error.code === "exists");
  await importEnvToFile({ env, force: true });
  const overlay = (await loadLlmEnv(env)).env;
  assert.equal(overlay.POTONGIN_LLM_MODEL, undefined);
  const script = [
    "import json, os, sys",
    "from ai_clipper.llm import load_llm_configs",
    "rows = [dict(c.public_dict(), key=c.api_key) for c in load_llm_configs(json.loads(sys.stdin.read()))]",
    "print(json.dumps(rows))",
  ].join("\n");
  const engine = async (input) => {
    const child = execFile(pythonBin(), ["-c", script], { env: { PATH: process.env.PATH } });
    const output = new Promise((resolve, reject) => {
      let text = "";
      child.stdout.on("data", (chunk) => { text += chunk; });
      child.on("close", (code) => (code === 0 ? resolve(JSON.parse(text)) : reject(new Error(`python exit ${code}`))));
    });
    child.stdin.end(JSON.stringify(input));
    return output;
  };
  const before = await engine(OWNER_ENV);
  const after = await engine(overlay);
  assert.deepEqual(after, before);
  assert.deepEqual(before.map((row) => row.provider), ["custom", "ollama-cloud", "openrouter"]);
});

// --- Status -------------------------------------------------------------------------------

test("the effective LLM status follows UI settings when present and the environment otherwise", async () => {
  const { env, dir, file } = await sandbox({ POTONGIN_LLM_PROVIDERS: "groq", GROQ_API_KEY: "inherited-groq" });
  assert.deepEqual(await readEffectiveLlmStatus(env), { ...readLlmStatus(env), source: "env" });

  await saveLlmSettings(hermesInput(), { env });
  const active = await readEffectiveLlmStatus(env);
  assert.equal(active.source, "ui");
  assert.equal(active.state, "active");
  assert.deepEqual(active.order, ["custom", "ollama-cloud", "openrouter"], "the inherited groq chain is ignored");
  assert.equal(active.providers.find((item) => item.name === "gemini").reason, "missing_api_key");
  assertNoSecrets(JSON.stringify(active), "status");

  const rotated = await readEffectiveLlmStatus({ ...env, APP_SESSION_SECRET: OTHER_SECRET });
  assert.equal(rotated.state, "unusable");
  assert.equal(rotated.providers[0].reason, "key_unreadable");

  const single = await sandbox();
  await saveLlmSettings({ enabled: true, freeOnly: false, providers: [{ provider: "custom", enabled: true, baseUrl: "https://h.example/v1", model: "m", apiKey: { action: "replace", value: KEYS.custom } }] }, { env: single.env });
  const unreadable = await readEffectiveLlmStatus({ ...single.env, APP_SESSION_SECRET: OTHER_SECRET });
  assert.match(unreadable.label, /custom: key tersimpan tidak bisa dibuka — isi ulang/);

  await saveLlmSettings({ ...hermesInput(), enabled: false }, { env });
  const off = await readEffectiveLlmStatus(env);
  assert.equal(off.state, "disabled");
  assert.equal(off.label, "AI dimatikan di Pengaturan — memakai heuristik");

  await writeFile(file, "{ broken");
  const corrupt = await readEffectiveLlmStatus(env);
  assert.equal(corrupt.state, "invalid");
  assert.match(corrupt.label, /rusak/);
  assert.ok(dir);
});

test("the settings view shows the environment until the owner imports or saves", async () => {
  const { env } = await sandbox(OWNER_ENV);
  const before = await readLlmSettingsView(env);
  assert.equal(before.envImportAvailable, true);
  assert.equal(before.secretConfigured, true);
  assert.equal(before.settings.source, "env");
  assert.deepEqual(before.settings.providers.map((item) => [item.provider, item.apiKeySet, item.source]), [
    ["custom", true, "env"], ["ollama-cloud", true, "env"], ["openrouter", true, "env"], ["gemini", false, "env"], ["groq", false, "env"],
  ]);
  assert.deepEqual(before.envWarnings, ["Penyedia 'mystery' tidak dikenal dan dilewati."]);
  assertNoSecrets(JSON.stringify(before), "view");
  await importEnvToFile({ env });
  const after = await readLlmSettingsView(env);
  assert.equal(after.envImportAvailable, false);
  assert.equal(after.settings.source, "ui");
  assert.equal(after.status.source, "ui");
  assertNoSecrets(JSON.stringify(after), "view");
});

// --- Command line -------------------------------------------------------------------------

test("the CLI imports the environment (or a dotenv file) once and prints no secrets", async () => {
  const { main, parseDotenv } = await import("../scripts/llm-settings.mjs");
  assert.deepEqual(parseDotenv([
    "# comment", "", "export A=1", "B = two # note", 'C="quoted # kept"', "D='single'", "not a line", "E=", "1BAD=x",
  ].join("\n")), { A: "1", B: "two", C: "quoted # kept", D: "single", E: "" });

  const { root, env, file } = await sandbox({ PATH: process.env.PATH, OLLAMA_API_KEY: "process-env-key-should-be-ignored" });
  const envFile = path.join(root, "owner.env");
  await writeFile(envFile, Object.entries(OWNER_ENV).map(([name, value]) => `${name}=${value}`).join("\n"));
  const capture = () => {
    const chunks = [];
    return { write: (chunk) => { chunks.push(String(chunk)); return true; }, text: () => chunks.join("") };
  };
  const io = () => ({ env, stdout: capture(), stderr: capture() });

  let streams = io();
  assert.equal(await main(["path"], streams), 0);
  assert.equal(streams.stdout.text(), `${file}\n`);

  streams = io();
  assert.equal(await main(["import-env", "--env-file", envFile], streams), 0, streams.stderr.text());
  assert.match(streams.stdout.text(), /custom \(aktif, key ✓\) → ollama-cloud \(aktif, key ✓\) → openrouter \(aktif, key ✓\) → gemini \(aktif, tanpa key\)/);
  assert.match(streams.stdout.text(), /Peringatan: Penyedia 'mystery'/);
  assertNoSecrets(streams.stdout.text() + streams.stderr.text(), "CLI output");
  const saved = (await readLlmSettings({ env })).settings;
  assert.equal(decryptApiKey(saved.providers[1].apiKey, "ollama-cloud", SECRET), KEYS["ollama-cloud"], "the env file wins over this process's LLM variables");

  streams = io();
  assert.equal(await main(["import-env"], streams), 1);
  assert.match(streams.stderr.text(), /--force/);

  streams = io();
  assert.equal(await main(["show"], streams), 0);
  const shown = JSON.parse(streams.stdout.text());
  assert.equal(shown.settings.source, "ui");
  assertNoSecrets(streams.stdout.text(), "show");

  streams = io();
  assert.equal(await main(["bogus"], streams), 2);
  streams = io();
  assert.equal(await main(["import-env", "--nope"], streams), 2);
});
