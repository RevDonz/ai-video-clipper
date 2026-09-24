// Read-only summary of the Selection V3 LLM configuration, derived from the
// process environment alone: no network call is made and no key value, key
// length, base URL or other secret-bearing value ever leaves this module. It
// mirrors the provider resolution in src/ai_clipper/llm.py (_resolve_configs)
// closely enough to tell the operator which providers the worker will try.

export const LLM_PROVIDERS = Object.freeze({
  gemini: { keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], requiresKey: true, paidOnly: false },
  groq: { keyEnv: ["GROQ_API_KEY"], requiresKey: true, paidOnly: false },
  openrouter: { keyEnv: ["OPENROUTER_API_KEY"], requiresKey: true, paidOnly: false },
  cerebras: { keyEnv: ["CEREBRAS_API_KEY"], requiresKey: true, paidOnly: false },
  mistral: { keyEnv: ["MISTRAL_API_KEY"], requiresKey: true, paidOnly: false },
  deepseek: { keyEnv: ["DEEPSEEK_API_KEY"], requiresKey: true, paidOnly: true },
  openai: { keyEnv: ["OPENAI_API_KEY"], requiresKey: true, paidOnly: true },
  ollama: { keyEnv: [], requiresKey: false, paidOnly: false, local: true },
  "ollama-cloud": { keyEnv: ["OLLAMA_API_KEY"], requiresKey: true, paidOnly: false },
  custom: { keyEnv: [], requiresKey: false, paidOnly: false, custom: true },
});

const OFF_VALUES = new Set(["off", "0", "false", "no", "disabled", "disable", "none"]);
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const NONE_VALUES = new Set(["none", "off", "-"]);
const PROVIDER_NAME = /^[a-z0-9-]{1,40}$/;
const KEY_SHAPE = /^[\x21-\x7e]{1,4096}$/;
// What the worker accepts as a model ID (llm.py _MODEL_RE) ...
const VALID_MODEL = /^[^\s\x00-\x1f\x7f]{1,200}$/u;
// ... and the stricter subset shown to the operator: plain identifier characters only.
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);
const REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high"]);
const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;
const MAX_LISTED_PROVIDERS = 12;
const MAX_LISTED_MODELS = 8;

function envText(env, name) {
  const value = env[name];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function scopedName(provider, suffix) {
  return `POTONGIN_LLM_${provider.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

// Scoped POTONGIN_LLM_<PROVIDER>_<NAME> first; the shared POTONGIN_LLM_<NAME>
// applies to identity settings (key, base URL, model, fallbacks) only for the
// first listed provider.
function setting(env, provider, suffix, primary) {
  const scoped = envText(env, scopedName(provider, suffix));
  if (scoped !== null) return scoped;
  if (!primary && ["API_KEY", "BASE_URL", "MODEL", "FALLBACK_MODELS"].includes(suffix)) return null;
  return envText(env, `POTONGIN_LLM_${suffix}`);
}

function isFreeModel(provider, model) {
  if (LLM_PROVIDERS[provider].paidOnly) return false;
  if (provider === "openrouter") return model.endsWith(":free") || model === "openrouter/free";
  return true;
}

function parseProviders(env) {
  const raw = envText(env, "POTONGIN_LLM_PROVIDER") ?? envText(env, "POTONGIN_LLM_PROVIDERS");
  if (raw === null) return { providers: [], invalid: false };
  const providers = [...new Set(raw.split(",").map((part) => part.trim().toLowerCase().replace(/_/g, "-")).filter(Boolean))];
  if (!providers.length || providers.some((name) => !PROVIDER_NAME.test(name))) return { providers: [], invalid: true };
  return { providers: providers.slice(0, MAX_LISTED_PROVIDERS), invalid: false };
}

function parseFreeOnly(env) {
  const raw = envText(env, "POTONGIN_LLM_FREE_ONLY");
  if (raw === null) return { freeOnly: false, invalid: false };
  const lowered = raw.toLowerCase();
  if (TRUE_VALUES.has(lowered)) return { freeOnly: true, invalid: false };
  if (FALSE_VALUES.has(lowered)) return { freeOnly: false, invalid: false };
  return { freeOnly: false, invalid: true };
}

function modelList(raw) {
  if (raw === null) return null;
  if (NONE_VALUES.has(raw.toLowerCase())) return [];
  return [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
}

function publicModel(value) {
  return typeof value === "string" && MODEL_NAME.test(value) ? value : null;
}

// The URL itself is never reported: it may carry credentials (user:pass@host).
function baseUrlValid(raw) {
  if (/\s/u.test(raw)) return false;
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (!url.hostname) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && LOCAL_HTTP_HOSTS.has(url.hostname.toLowerCase());
}

function numberInRange(raw, { integer = false, low, high, lowOpen = false }) {
  if (!(integer ? INTEGER : DECIMAL).test(raw)) return false;
  const value = Number(raw);
  if (!Number.isFinite(value)) return false;
  return (lowOpen ? value > low : value >= low) && value <= high;
}

// Tuning variables the worker parses strictly (llm.py _provider_config); a bad
// value makes it reject the whole LLM configuration, so the status must say so.
const TUNING_RULES = Object.freeze({
  TIMEOUT: (raw) => numberInRange(raw, { low: 0, high: 3600, lowOpen: true }),
  MAX_RETRIES: (raw) => numberInRange(raw, { integer: true, low: 0, high: 10 }),
  TEMPERATURE: (raw) => numberInRange(raw, { low: 0, high: 2 }),
  MAX_OUTPUT_TOKENS: (raw) => numberInRange(raw, { integer: true, low: 1, high: 1_000_000 }),
  CONTEXT_TOKENS: (raw) => numberInRange(raw, { integer: true, low: 512, high: 10_000_000 }),
  RPM: (raw) => OFF_VALUES.has(raw.toLowerCase()) || Number(raw) === 0
    || numberInRange(raw, { low: 0, high: 100_000, lowOpen: true }),
  JSON_MODE: (raw) => TRUE_VALUES.has(raw.toLowerCase()) || FALSE_VALUES.has(raw.toLowerCase()),
  REASONING_EFFORT: (raw) => REASONING_EFFORTS.has(raw.toLowerCase()),
});

function tuningValid(env, provider, primary) {
  return Object.entries(TUNING_RULES).every(([suffix, valid]) => {
    const raw = setting(env, provider, suffix, primary);
    return raw === null || valid(raw);
  });
}

function describeProvider(env, name, primary, freeOnly, unreadableKeys = null) {
  const preset = LLM_PROVIDERS[name];
  if (!preset) {
    return { name, known: false, keySet: false, usable: false, reason: "unknown_provider", paid: false, local: false, modelOverride: null, fallbackOverride: null };
  }
  let key = setting(env, name, "API_KEY", primary);
  for (const variable of preset.keyEnv) {
    if (key !== null) break;
    key = envText(env, variable);
  }
  const keySet = key !== null;
  const modelRaw = setting(env, name, "MODEL", primary);
  const fallbackRaw = setting(env, name, "FALLBACK_MODELS", primary);
  const fallbacks = modelList(fallbackRaw);
  const described = {
    name,
    known: true,
    keySet,
    usable: false,
    reason: null,
    paid: preset.paidOnly,
    local: Boolean(preset.local),
    modelOverride: modelRaw === null ? null : publicModel(modelRaw),
    fallbackOverride: fallbacks === null ? null : fallbacks.map(publicModel).filter(Boolean).slice(0, MAX_LISTED_MODELS),
  };

  const baseUrl = setting(env, name, "BASE_URL", primary);
  // Same order as llm.py _provider_config, so the first problem found is the
  // one the worker reports (only missing_api_key and not_free are skippable).
  let reason = null;
  if (freeOnly && preset.paidOnly) reason = "not_free";
  else if (preset.custom && baseUrl === null) reason = "config_invalid";
  else if (baseUrl !== null && !baseUrlValid(baseUrl)) reason = "config_invalid";
  else if (preset.custom && modelRaw === null) reason = "config_invalid";
  else if (modelRaw !== null && !VALID_MODEL.test(modelRaw)) reason = "config_invalid";
  else if (!keySet && preset.requiresKey) reason = "missing_api_key";
  else if (keySet && !KEY_SHAPE.test(key)) reason = "config_invalid";
  else if (fallbacks !== null && fallbacks.some((model) => !VALID_MODEL.test(model))) reason = "config_invalid";
  else if (freeOnly && name === "openrouter") {
    // Preset OpenRouter models are all ":free"; only overrides can remove every free model.
    const chain = [modelRaw ?? "openrouter/free", ...(fallbacks ?? ["openrouter/free"])];
    if (!chain.some((model) => isFreeModel(name, model))) reason = "not_free";
  }
  if (reason === null && !tuningValid(env, name, primary)) reason = "config_invalid";
  // A key saved in the UI that the current secret cannot open (settings store).
  if ((reason === null || reason === "missing_api_key") && unreadableKeys?.has(name)) reason = "key_unreadable";
  described.reason = reason;
  described.usable = reason === null;
  return described;
}

const REASON_TEXT = {
  missing_api_key: "API key belum diisi",
  not_free: "tidak gratis (POTONGIN_LLM_FREE_ONLY aktif)",
  config_invalid: "konfigurasi tidak valid",
  unknown_provider: "nama penyedia tidak dikenal",
  key_unreadable: "key tersimpan tidak bisa dibuka — isi ulang",
};

export function llmReasonText(reason) {
  return REASON_TEXT[reason] || "tidak siap";
}

/**
 * The dashboard's view of the LLM configuration.
 *
 * state: "active" (at least one provider usable), "disabled" (POTONGIN_LLM=off),
 * "unconfigured" (no provider listed), "unusable" (listed, none usable) or
 * "invalid" (a variable the worker would reject outright).
 */
export function readLlmStatus(env = process.env, { unreadableKeys = null } = {}) {
  const base = { state: "unconfigured", freeOnly: false, order: [], providers: [], problems: [] };
  const switchValue = envText(env, "POTONGIN_LLM");
  if (switchValue !== null && OFF_VALUES.has(switchValue.toLowerCase())) {
    return { ...base, state: "disabled", label: "LLM dimatikan (POTONGIN_LLM=off) — memakai heuristik" };
  }
  const { providers, invalid: invalidProviders } = parseProviders(env);
  const { freeOnly, invalid: invalidFreeOnly } = parseFreeOnly(env);
  const problems = [];
  if (invalidProviders) problems.push("config_invalid:POTONGIN_LLM_PROVIDERS");
  if (invalidFreeOnly) problems.push("config_invalid:POTONGIN_LLM_FREE_ONLY");
  if (problems.length) {
    return { ...base, state: "invalid", freeOnly, problems, label: "Konfigurasi LLM tidak valid — memakai heuristik" };
  }
  if (!providers.length) {
    return { ...base, freeOnly, label: "LLM belum dikonfigurasi — memakai heuristik" };
  }
  const described = providers.map((name, index) => describeProvider(env, name, index === 0, freeOnly, unreadableKeys));
  // Only a missing key, FREE_ONLY or an unknown name is skipped in a list; any
  // other problem makes the worker reject the whole LLM configuration.
  const broken = described.find((item) => item.reason === "config_invalid");
  if (broken) {
    return {
      ...base,
      state: "invalid",
      freeOnly,
      providers: described,
      problems: [`config_invalid:${broken.name}`],
      label: `Konfigurasi LLM tidak valid (${broken.name}) — memakai heuristik`,
    };
  }
  const order = described.filter((item) => item.usable).map((item) => item.name);
  // A single listed provider is not skipped when unusable: the worker rejects it.
  const single = described.length === 1;
  if (!order.length) {
    const first = described[0];
    const detail = single ? ` (${first.name}: ${llmReasonText(first.reason)})` : "";
    return {
      ...base,
      state: "unusable",
      freeOnly,
      providers: described,
      label: `LLM belum siap${detail} — memakai heuristik`,
    };
  }
  return {
    ...base,
    state: "active",
    freeOnly,
    order,
    providers: described,
    label: `LLM aktif: ${order.join(" → ")}${freeOnly ? " (hanya model gratis)" : ""}`,
  };
}
