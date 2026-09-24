import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSettingsInput, publicSettingsView } from "../lib/llm-settings.mjs";
import {
  availableProviders,
  baseUrlHost,
  draftFromSettings,
  draftSignature,
  draftToPayload,
  moveProvider,
  parseModelList,
  providerDraft,
  providerStatusLine,
} from "../lib/llm-settings-view.mjs";

const SECRET = "view-secret-".padEnd(40, "v");

function stored() {
  return normalizeSettingsInput({
    enabled: true, freeOnly: true,
    providers: [
      { provider: "custom", enabled: true, baseUrl: "https://hermes.example/v1", model: "LJNAI-FAST", reasoningEffort: "none", contextTokens: 65536, timeout: 600, apiKey: { action: "replace", value: "hermes-key-1" } },
      { provider: "openrouter", enabled: false, fallbackModels: [], rpm: 0, jsonMode: false, httpReferer: "https://potongin.example", apiKey: { action: "replace", value: "sk-or-2" } },
      { provider: "gemini", enabled: true, fallbackModels: ["gemini-3.8-flash", "gemini-3.1-flash-lite"] },
    ],
  }, { secret: SECRET, now: new Date("2026-09-24T01:00:00Z") });
}

test("a saved document round-trips through the page draft unchanged (keys kept)", () => {
  const saved = stored();
  const view = publicSettingsView(saved, { secret: SECRET, source: "ui" });
  const draft = draftFromSettings(view);
  assert.equal(draft.providers[0].keySource, "ui");
  assert.equal(draft.providers[0].contextTokens, "65536");
  assert.equal(draft.providers[1].fallbackText, "none");
  assert.equal(draft.providers[1].rpm, "0");
  assert.equal(draft.providers[1].jsonMode, "false");
  assert.equal(draft.providers[2].fallbackText, "gemini-3.8-flash, gemini-3.1-flash-lite");
  const { payload, errors } = draftToPayload(draft, view.updatedAt);
  assert.deepEqual(errors, {});
  assert.equal(payload.baseUpdatedAt, "2026-09-24T01:00:00.000Z");
  assert.deepEqual(payload.providers.map((item) => item.apiKey.action), ["keep", "keep", "clear"], "keep what is stored; a provider without a key sends clear");
  const again = normalizeSettingsInput(payload, { base: saved, secret: SECRET, now: new Date("2026-09-24T01:00:00Z") });
  assert.deepEqual(again, saved);
  assert.equal(draftSignature(draftFromSettings(view)), draftSignature(draft));
});

test("the draft validates like the server and marks the field that is wrong", () => {
  const draft = draftFromSettings(null);
  assert.deepEqual(draft, { enabled: true, freeOnly: false, providers: [] });
  draft.providers.push({ ...providerDraft("custom"), baseUrl: "http://remote.example/v1", keyAction: "replace", keyValue: "  " });
  draft.providers.push({ ...providerDraft("groq"), model: "has space", contextTokens: "100", timeout: "abc", fallbackText: "ok, bad\u0000model" });
  const { errors } = draftToPayload(draft);
  assert.match(errors["providers[0].baseUrl"], /http:\/\/ hanya diizinkan/);
  assert.match(errors["providers[0].model"], /wajib/);
  assert.match(errors["providers[0].apiKey"], /Isi API key baru/);
  assert.ok(errors["providers[1].model"]);
  assert.match(errors["providers[1].contextTokens"], /Konteks token harus antara 512/);
  assert.match(errors["providers[1].timeout"], /angka/);
  assert.ok(errors["providers[1].fallbackModels"]);

  const replaced = draftToPayload({ enabled: true, freeOnly: false, providers: [{ ...providerDraft("groq"), keyAction: "replace", keyValue: " gsk_new \n", temperature: "0,5" }] });
  assert.deepEqual(replaced.errors, {});
  assert.deepEqual(replaced.payload.providers[0], { provider: "groq", enabled: true, temperature: 0.5, apiKey: { action: "replace", value: "gsk_new" } });
  const cleared = draftToPayload({ enabled: false, freeOnly: false, providers: [{ ...providerDraft("groq", { apiKeySet: true }), keyAction: "clear" }] });
  assert.deepEqual(cleared.payload.providers[0].apiKey, { action: "clear" });
  // HTTP-Referer / app title only apply to OpenRouter.
  assert.equal(draftToPayload({ enabled: true, freeOnly: false, providers: [{ ...providerDraft("groq"), appTitle: "x" }] }).payload.providers[0].appTitle, undefined);
});

test("a provider removed and added again before saving starts without its old key", () => {
  const saved = stored();
  const view = publicSettingsView(saved, { secret: SECRET, source: "ui" });
  const draft = draftFromSettings(view);
  // Remove Hermes (the page warns its key goes too), then add it back fresh.
  draft.providers = [...draft.providers.slice(1), { ...providerDraft("custom"), baseUrl: "https://hermes.example/v1", model: "LJNAI-FAST" }];
  const { payload, errors } = draftToPayload(draft, view.updatedAt);
  assert.deepEqual(errors, {});
  assert.deepEqual(payload.providers[2].apiKey, { action: "clear" }, "the page shows 'Belum diisi', so nothing is kept");
  assert.deepEqual(payload.providers[0].apiKey, { action: "keep" }, "a key the page shows as stored is kept");
  const again = normalizeSettingsInput(payload, { base: saved, secret: SECRET });
  assert.equal(again.providers.find((item) => item.provider === "custom").apiKey, undefined);
  assert.ok(again.providers.find((item) => item.provider === "openrouter").apiKey);
});

test("list helpers keep the failover order explicit", () => {
  const list = ["a", "b", "c"];
  assert.deepEqual(moveProvider(list, 1, -1), ["b", "a", "c"]);
  assert.deepEqual(moveProvider(list, 2, 1), list);
  assert.deepEqual(moveProvider(list, 0, -1), list);
  assert.deepEqual(availableProviders({ providers: [{ provider: "custom" }, { provider: "gemini" }] }), ["groq", "openrouter", "cerebras", "mistral", "deepseek", "openai", "ollama", "ollama-cloud"]);
  assert.equal(parseModelList(""), null);
  assert.deepEqual(parseModelList(" none "), []);
  assert.deepEqual(parseModelList("a, b\nc,a"), ["a", "b", "c"]);
  assert.deepEqual(providerStatusLine({ usable: true }), { tone: "ok", text: "Siap dipakai" });
  assert.equal(providerStatusLine({ usable: false, reason: "key_unreadable" }).tone, "error");
  assert.equal(providerStatusLine(null), null);
  assert.equal(baseUrlHost("https://hermes.example:8443/v1"), "hermes.example:8443");
  assert.equal(baseUrlHost("http://remote.example/v1"), null);
});
