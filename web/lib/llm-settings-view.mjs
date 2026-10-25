// Client-safe helpers for the AI tab of Pengaturan (/settings#ai): turning the GET
// payload into an editable draft of strings and back into a PUT body, with the
// same rules the server applies (lib/llm-presets.mjs). No Node built-ins.
// Messages are descriptors `{ key, values? }` under the "settings" namespace
// (rombak 07 §8.3); `problem` is the shared validator's own phrase.

import { contentLower } from "./content-text.mjs";
import {
  CUSTOM_PROVIDERS,
  LLM_PRESETS,
  MAX_FALLBACK_MODELS,
  NUMBER_RULES,
  PROVIDER_NAMES,
  SERVER_TEMPLATES,
  apiKeyProblem,
  appTitleProblem,
  baseUrlProblem,
  displayNameProblem,
  fallbackModelProblem,
  httpRefererProblem,
  isCustomProvider,
  modelProblem,
  numberProblem,
} from "./llm-presets.mjs";

export const NUMBER_FIELDS = Object.freeze(Object.keys(NUMBER_RULES));
const TEXT_FIELDS = Object.freeze(["baseUrl", "model", "httpReferer", "appTitle"]);
const NONE_WORDS = new Set(["none", "off", "-"]);
const FIELD_ERRORS = Object.freeze({ baseUrl: "ai.error.baseUrl", model: "ai.error.model", httpReferer: "ai.error.httpReferer", appTitle: "ai.error.appTitle" });
const NUMBER_ERRORS = Object.freeze(Object.fromEntries(Object.keys(NUMBER_RULES).map((field) => [field, `ai.error.number.${field}`])));

function text(value) {
  return value === undefined || value === null ? "" : String(value);
}

export function providerDraft(provider, source = {}) {
  const draft = {
    provider,
    enabled: source.enabled !== false,
    name: text(source.name),
    baseUrl: text(source.baseUrl),
    model: text(source.model),
    fallbackText: Array.isArray(source.fallbackModels) ? (source.fallbackModels.length ? source.fallbackModels.join(", ") : "none") : "",
    reasoningEffort: text(source.reasoningEffort),
    jsonMode: typeof source.jsonMode === "boolean" ? String(source.jsonMode) : "",
    httpReferer: text(source.httpReferer),
    appTitle: text(source.appTitle),
    apiKeySet: source.apiKeySet === true,
    apiKeyUnreadable: source.apiKeyUnreadable === true,
    keySource: source.apiKeySet ? (source.source === "env" ? "env" : "ui") : null,
    keyAction: "keep",
    keyValue: "",
  };
  for (const field of NUMBER_FIELDS) draft[field] = text(source[field]);
  return draft;
}

/** An editable draft (strings) of the settings the GET route returned. */
export function draftFromSettings(settings) {
  if (!settings) return { enabled: true, freeOnly: false, providers: [] };
  return {
    enabled: settings.enabled !== false,
    freeOnly: settings.freeOnly === true,
    providers: (settings.providers || []).filter((item) => PROVIDER_NAMES.includes(item.provider)).map((item) => providerDraft(item.provider, item)),
  };
}

export function draftSignature(draft) {
  return JSON.stringify(draft);
}

/** Per-provider signatures, to tell which providers differ from the saved settings. */
export function providerSignatures(draft) {
  return Object.fromEntries(draft.providers.map((item) => [item.provider, JSON.stringify(item)]));
}

export function moveProvider(providers, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= providers.length || target < 0 || target >= providers.length) return providers;
  const next = [...providers];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Presets not yet in the list. Custom servers are added from SERVER_TEMPLATES instead. */
export function availableProviders(draft) {
  const used = new Set(draft.providers.map((item) => item.provider));
  return PROVIDER_NAMES.filter((name) => !used.has(name) && !isCustomProvider(name));
}

/** The id a new custom server gets (the first free of custom, custom2, custom3), or null. */
export function nextCustomProvider(draft) {
  const used = new Set(draft.providers.map((item) => item.provider));
  return CUSTOM_PROVIDERS.find((name) => !used.has(name)) ?? null;
}

/** A fresh draft for a new custom server prefilled from a template, or null when none is free. */
export function customServerDraft(draft, templateId) {
  const template = Object.hasOwn(SERVER_TEMPLATES, templateId) ? SERVER_TEMPLATES[templateId] : null;
  const provider = nextCustomProvider(draft);
  if (!template || !provider) return null;
  return providerDraft(provider, { name: template.name, baseUrl: template.baseUrl });
}

/** What the page calls a provider: a custom server's own name, else the preset label. */
export function providerLabel(item) {
  const name = isCustomProvider(item.provider) && typeof item.name === "string" ? item.name.trim() : "";
  return name || LLM_PRESETS[item.provider].label;
}

/**
 * Models of a 9Router-like server (primary and fallbacks) that go through a
 * consumer subscription (cc/, cx/, gh/, cu/): the page warns before they are
 * used for automated jobs.
 */
export function subscriptionModels(item) {
  const template = SERVER_TEMPLATES[serverTemplateFor(item)];
  if (!template?.subscriptionPrefixes) return [];
  const models = [item.model.trim(), ...(parseModelList(item.fallbackText) || [])].filter(Boolean);
  return [...new Set(models.filter((model) => template.subscriptionPrefixes.some((prefix) => model.toLowerCase().startsWith(prefix))))];
}

/** The template a custom server looks like (for its hints), or null. */
export function serverTemplateFor(item) {
  if (!isCustomProvider(item?.provider)) return null;
  if (/9\s*router/i.test(item.name || "")) return "9router";
  try {
    if (item.baseUrl && new URL(item.baseUrl.trim()).port === "20128") return "9router";
  } catch {
    // Not a URL yet (still typing).
  }
  return null;
}

/** Model ids typed as "a, b" or one per line; null means "use the preset default". */
export function parseModelList(raw) {
  const value = raw.trim();
  if (!value) return null;
  if (NONE_WORDS.has(value.toLowerCase())) return [];
  return [...new Set(value.split(/[\s,]+/).filter(Boolean))];
}

/**
 * The PUT body for a draft plus field errors keyed like the server's issues
 * ("providers[0].baseUrl"). Empty strings mean "use the preset default".
 */
export function draftToPayload(draft, baseUpdatedAt = null) {
  const errors = {};
  const names = new Set();
  const providers = draft.providers.map((item, index) => {
    const prefix = `providers[${index}]`;
    const preset = LLM_PRESETS[item.provider];
    const out = { provider: item.provider, enabled: item.enabled };
    const name = isCustomProvider(item.provider) ? (item.name || "").trim() : "";
    if (name) {
      const problem = displayNameProblem(name);
      const folded = contentLower(name);
      if (problem) errors[`${prefix}.name`] = { key: "ai.error.name", values: { problem } };
      else if (names.has(folded)) errors[`${prefix}.name`] = { key: "ai.error.nameTaken" };
      else out.name = name;
      names.add(folded);
    }
    for (const field of TEXT_FIELDS) {
      const value = item[field].trim();
      if (!value) continue;
      if ((field === "httpReferer" || field === "appTitle") && item.provider !== "openrouter") continue;
      const problem = field === "baseUrl" ? baseUrlProblem(value)
        : field === "model" ? modelProblem(value)
          : field === "httpReferer" ? httpRefererProblem(value) : appTitleProblem(value);
      if (problem) errors[`${prefix}.${field}`] = { key: FIELD_ERRORS[field], values: { problem } };
      else out[field] = value;
    }
    const fallbacks = parseModelList(item.fallbackText);
    if (fallbacks !== null) {
      const problem = fallbacks.map(fallbackModelProblem).find(Boolean);
      if (problem) errors[`${prefix}.fallbackModels`] = { key: "ai.error.fallback", values: { problem } };
      else if (fallbacks.length > MAX_FALLBACK_MODELS) errors[`${prefix}.fallbackModels`] = { key: "ai.error.fallbackMax", values: { max: MAX_FALLBACK_MODELS } };
      else out.fallbackModels = fallbacks;
    }
    if (item.reasoningEffort) out.reasoningEffort = item.reasoningEffort;
    for (const field of NUMBER_FIELDS) {
      const raw = item[field].trim().replace(",", ".");
      if (!raw) continue;
      const value = Number(raw);
      const problem = numberProblem(field, value);
      if (problem) errors[`${prefix}.${field}`] = { key: NUMBER_ERRORS[field], values: { problem } };
      else out[field] = value;
    }
    if (item.jsonMode === "true" || item.jsonMode === "false") out.jsonMode = item.jsonMode === "true";
    if (item.enabled && preset.baseUrl === null) {
      if (!out.baseUrl && !errors[`${prefix}.baseUrl`]) errors[`${prefix}.baseUrl`] = { key: "ai.error.baseUrlRequired" };
      if (!out.model && !errors[`${prefix}.model`]) errors[`${prefix}.model`] = { key: "ai.error.modelRequired" };
    }
    if (item.keyAction === "replace") {
      const value = item.keyValue.trim();
      if (!value) errors[`${prefix}.apiKey`] = { key: "ai.error.keyEmpty" };
      else if (apiKeyProblem(value)) errors[`${prefix}.apiKey`] = { key: "ai.error.key", values: { problem: apiKeyProblem(value) } };
      else out.apiKey = { action: "replace", value };
    } else {
      // "keep" only for a key the page shows as stored: a provider removed and
      // added back before saving must not silently keep its old key.
      out.apiKey = { action: item.keyAction === "clear" || !item.apiKeySet ? "clear" : "keep" };
    }
    return out;
  });
  return {
    payload: { baseUpdatedAt, enabled: draft.enabled, freeOnly: draft.freeOnly, providers },
    errors,
  };
}

const STATUS_REASONS = Object.freeze({
  missing_api_key: "ai.status.missingKey",
  not_free: "ai.status.notFree",
  config_invalid: "ai.status.invalid",
  unknown_provider: "ai.status.unknown",
  key_unreadable: "ai.status.keyUnreadable",
});

/** The status chip of one provider of the effective status: `{ tone, key }`, or null. */
export function providerStatusLine(statusProvider) {
  if (!statusProvider) return null;
  if (statusProvider.usable) return { tone: "ok", key: "ai.status.ready" };
  const tone = statusProvider.reason === "config_invalid" || statusProvider.reason === "key_unreadable" ? "error" : "warning";
  return { tone, key: Object.hasOwn(STATUS_REASONS, statusProvider.reason) ? STATUS_REASONS[statusProvider.reason] : "ai.status.notReady" };
}

/** Every key this module can name, for the catalog test and the tab's lookup. */
export const LLM_SETTINGS_VIEW_KEYS = Object.freeze([
  "ai.error.name",
  "ai.error.nameTaken",
  ...Object.values(FIELD_ERRORS),
  "ai.error.fallback",
  "ai.error.fallbackMax",
  ...Object.values(NUMBER_ERRORS),
  "ai.error.baseUrlRequired",
  "ai.error.modelRequired",
  "ai.error.keyEmpty",
  "ai.error.key",
  "ai.status.ready",
  "ai.status.notReady",
  ...Object.values(STATUS_REASONS),
]);

/** The host of a base URL for display, or null. */
export function baseUrlHost(raw) {
  if (!raw || baseUrlProblem(raw)) return null;
  try { return new URL(raw).host; } catch { return null; }
}
