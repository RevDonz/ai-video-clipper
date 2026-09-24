import assert from "node:assert/strict";
import test from "node:test";

import { SERVER_TEMPLATES } from "../lib/llm-presets.mjs";
import { normalizeSettingsInput, publicSettingsView } from "../lib/llm-settings.mjs";
import {
  availableProviders,
  baseUrlHost,
  customServerDraft,
  draftFromSettings,
  draftSignature,
  draftToPayload,
  moveProvider,
  nextCustomProvider,
  parseModelList,
  providerDraft,
  providerLabel,
  providerStatusLine,
  serverTemplateFor,
  subscriptionModels,
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

function servers() {
  return normalizeSettingsInput({
    enabled: true, freeOnly: true,
    providers: [
      { provider: "custom", enabled: true, name: "Hermes", baseUrl: "https://hermes.example/v1", model: "LJNAI-FAST", reasoningEffort: "none", apiKey: { action: "replace", value: "hermes-key-1" } },
      { provider: "ollama-cloud", enabled: true, apiKey: { action: "replace", value: "cloud-key-2" } },
      { provider: "custom2", enabled: true, name: "9Router", baseUrl: "http://host.docker.internal:20128/v1", model: "kr/glm-5", fallbackModels: ["combo-free"], timeout: 240, apiKey: { action: "replace", value: "router-key-3" } },
      { provider: "custom3", enabled: false, baseUrl: "http://localhost:1234/v1", model: "local" },
    ],
  }, { secret: SECRET, now: new Date("2026-09-24T02:00:00Z") });
}

test("several named custom servers round-trip through the page draft unchanged", () => {
  const saved = servers();
  const view = publicSettingsView(saved, { secret: SECRET, source: "ui" });
  const draft = draftFromSettings(view);
  assert.deepEqual(draft.providers.map((item) => [item.provider, item.name]), [["custom", "Hermes"], ["ollama-cloud", ""], ["custom2", "9Router"], ["custom3", ""]]);
  assert.deepEqual(draft.providers.map(providerLabel), ["Hermes", "Ollama Cloud", "9Router", "Server OpenAI-compatible 3"]);
  const { payload, errors } = draftToPayload(draft, view.updatedAt);
  assert.deepEqual(errors, {});
  assert.equal(payload.providers[2].name, "9Router");
  assert.equal(payload.providers[1].name, undefined, "only custom servers send a name");
  assert.deepEqual(payload.providers.map((item) => item.apiKey.action), ["keep", "keep", "keep", "clear"]);
  assert.deepEqual(normalizeSettingsInput(payload, { base: saved, secret: SECRET, now: new Date("2026-09-24T02:00:00Z") }), saved);

  // Renaming is an edit like any other; blank goes back to the default label.
  draft.providers[0] = { ...draft.providers[0], name: "  Hermes GPU  " };
  draft.providers[2] = { ...draft.providers[2], name: "" };
  const renamed = draftToPayload(draft, view.updatedAt);
  assert.deepEqual(renamed.errors, {});
  assert.equal(renamed.payload.providers[0].name, "Hermes GPU");
  assert.equal(renamed.payload.providers[2].name, undefined);
  assert.equal(providerLabel(draft.providers[2]), "Server OpenAI-compatible 2");
});

test("the draft checks server names like the server does", () => {
  const draft = draftFromSettings(publicSettingsView(servers(), { secret: SECRET, source: "ui" }));
  draft.providers[2] = { ...draft.providers[2], name: "hermes" };
  draft.providers[3] = { ...draft.providers[3], name: "x".repeat(41) };
  const { errors } = draftToPayload(draft);
  assert.match(errors["providers[2].name"], /sudah dipakai/);
  assert.match(errors["providers[3].name"], /1–40 karakter/);
  draft.providers[1] = { ...draft.providers[1], name: "ignored for presets" };
  assert.equal(draftToPayload(draft).payload.providers[1].name, undefined);
});

test("new servers take the next free custom id, up to three, from a template", () => {
  const empty = draftFromSettings(null);
  assert.equal(nextCustomProvider(empty), "custom");
  const router = customServerDraft(empty, "9router");
  assert.equal(router.provider, "custom");
  assert.equal(router.name, "9Router");
  assert.equal(router.baseUrl, "http://host.docker.internal:20128/v1");
  assert.equal(router.model, "");
  assert.equal(router.apiKeySet, false);
  assert.equal(SERVER_TEMPLATES["9router"].baseUrl, router.baseUrl);
  assert.match(SERVER_TEMPLATES["9router"].warning, /langganan/);
  assert.match(SERVER_TEMPLATES["9router"].warning, /ketentuan/);

  const draft = { enabled: true, freeOnly: false, providers: [{ ...providerDraft("custom2"), name: "9Router" }, providerDraft("gemini")] };
  assert.equal(nextCustomProvider(draft), "custom", "a gap is filled first");
  const generic = customServerDraft(draft, "generic");
  assert.deepEqual([generic.provider, generic.name, generic.baseUrl], ["custom", "", ""]);
  draft.providers.push(generic, providerDraft("custom3"));
  assert.equal(nextCustomProvider(draft), null);
  assert.equal(customServerDraft(draft, "generic"), null, "at most three servers");
  assert.equal(customServerDraft(empty, "nope"), null);
  assert.ok(!availableProviders(draft).some((name) => name.startsWith("custom")), "servers are added from templates, not the preset list");

  assert.equal(serverTemplateFor({ provider: "custom", name: "9Router", baseUrl: "" }), "9router");
  assert.equal(serverTemplateFor({ provider: "custom2", name: "Gateway", baseUrl: "http://host.docker.internal:20128/v1" }), "9router");
  assert.equal(serverTemplateFor({ provider: "custom", name: "Hermes", baseUrl: "https://hermes.example/v1" }), null);
  assert.equal(serverTemplateFor({ provider: "openrouter", name: "", baseUrl: "https://x.example:20128/v1" }), null);
});

test("a 9Router server warns about models that go through a consumer subscription", () => {
  const router = { ...providerDraft("custom2", { name: "9Router", baseUrl: "http://host.docker.internal:20128/v1" }), model: "cc/claude-sonnet-5", fallbackText: "ollama/gpt-oss:120b, CX/gpt-5.5, cc/claude-sonnet-5" };
  assert.deepEqual(subscriptionModels(router), ["cc/claude-sonnet-5", "CX/gpt-5.5"]);
  assert.deepEqual(subscriptionModels({ ...router, model: "ollama/gpt-oss:120b", fallbackText: "none" }), []);
  assert.deepEqual(subscriptionModels({ ...providerDraft("custom"), name: "Hermes", baseUrl: "https://hermes.example/v1", model: "cc/looks-like-a-prefix" }), [], "only 9Router uses these prefixes");
});
