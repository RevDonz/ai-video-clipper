// LLM provider presets and value rules shared by the settings page (browser)
// and the settings store (server). Client-safe: no Node built-ins.
//
// The presets mirror src/ai_clipper/llm.py (PRESETS); tests/llm-settings.test.mjs
// compares them with `python -m ai_clipper.llm --show-presets --json` so the
// page never shows a default the engine does not use. The value rules mirror
// the engine's validation (LLMConfig, _provider_config) and add a few stricter
// ones for URLs that the server itself may fetch (link-local and cloud metadata
// hosts are refused).

export const PROVIDER_NAMES = Object.freeze([
  "gemini", "groq", "openrouter", "cerebras", "mistral", "deepseek", "openai", "ollama", "ollama-cloud", "custom",
]);

function preset(fields) {
  return Object.freeze({ ...fields, fallbackModels: Object.freeze([...fields.fallbackModels]), keyEnv: Object.freeze([...fields.keyEnv]) });
}

export const LLM_PRESETS = Object.freeze({
  gemini: preset({
    label: "Google AI Studio (Gemini)",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-3.5-flash-lite",
    fallbackModels: ["gemini-3.1-flash-lite", "gemini-3.8-flash"],
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    requiresKey: true, paidOnly: false, contextTokens: 131_072, maxOutputTokens: 8192, timeout: 180, rpm: 10,
    keyUrl: "https://aistudio.google.com/apikey",
    description: "Gratis dari Google. Konteks besar, bahasa Indonesia bagus; Flash-Lite ±500 permintaan/hari. Data free tier boleh dipakai Google.",
  }),
  groq: preset({
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "openai/gpt-oss-120b",
    fallbackModels: ["qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
    keyEnv: ["GROQ_API_KEY"],
    requiresKey: true, paidOnly: false, contextTokens: 8000, maxOutputTokens: 3000, timeout: 120, rpm: 25,
    keyUrl: "https://console.groq.com/keys",
    description: "Gratis dan sangat cepat, tapi dibatasi 8.000 token/menit: episode panjang dipotong kecil-kecil.",
  }),
  openrouter: preset({
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "qwen/qwen3.8-27b:free",
    fallbackModels: ["google/gemma-4-31b-it:free", "openrouter/free"],
    keyEnv: ["OPENROUTER_API_KEY"],
    requiresKey: true, paidOnly: false, contextTokens: 131_072, maxOutputTokens: 8192, timeout: 180, rpm: 16,
    keyUrl: "https://openrouter.ai/settings/keys",
    description: "Banyak model ':free' plus router openrouter/free. 20 permintaan/menit, 50/hari (1.000/hari setelah beli kredit).",
  }),
  cerebras: preset({
    label: "Cerebras",
    baseUrl: "https://api.cerebras.ai/v1",
    defaultModel: "gpt-oss-120b",
    fallbackModels: ["qwen-3.8-27b"],
    keyEnv: ["CEREBRAS_API_KEY"],
    requiresKey: true, paidOnly: false, contextTokens: 30_000, maxOutputTokens: 8192, timeout: 120, rpm: 5,
    keyUrl: "https://cloud.cerebras.ai",
    description: "Gratis: 1 juta token/hari, 5 permintaan/menit.",
  }),
  mistral: preset({
    label: "Mistral La Plateforme",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    fallbackModels: ["mistral-medium-latest"],
    keyEnv: ["MISTRAL_API_KEY"],
    requiresKey: true, paidOnly: false, contextTokens: 32_000, maxOutputTokens: 8192, timeout: 180, rpm: 50,
    keyUrl: "https://console.mistral.ai/api-keys",
    description: "Paket Experiment gratis; data dipakai untuk training kecuali Anda opt-out.",
  }),
  deepseek: preset({
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    defaultModel: "deepseek-flash",
    fallbackModels: ["deepseek-v4-pro"],
    keyEnv: ["DEEPSEEK_API_KEY"],
    requiresKey: true, paidOnly: true, contextTokens: 131_072, maxOutputTokens: 8192, timeout: 300, rpm: null,
    keyUrl: "https://platform.deepseek.com/api_keys",
    description: "Berbayar tapi sangat murah (±$0,01–0,03 per episode). Data diproses di Tiongkok.",
  }),
  openai: preset({
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-6-luna",
    fallbackModels: [],
    keyEnv: ["OPENAI_API_KEY"],
    requiresKey: true, paidOnly: true, contextTokens: 131_072, maxOutputTokens: 16_384, timeout: 180, rpm: null,
    keyUrl: "https://platform.openai.com/api-keys",
    description: "Berbayar (gpt-6-luna $0,10/$0,50 per 1 juta token).",
  }),
  ollama: preset({
    label: "Ollama (lokal)",
    baseUrl: "http://localhost:11434/v1",
    defaultModel: "qwen3.5:9b",
    fallbackModels: [],
    keyEnv: [],
    requiresKey: false, paidOnly: false, local: true, contextTokens: 8192, maxOutputTokens: 4096, timeout: 900, rpm: null,
    keyUrl: null,
    description: "Gratis dan privat di mesin sendiri, tanpa key. Lambat tanpa GPU. Dari Docker pakai http://host.docker.internal:11434/v1.",
  }),
  "ollama-cloud": preset({
    label: "Ollama Cloud",
    baseUrl: "https://ollama.com/v1",
    defaultModel: "gemma4:31b",
    fallbackModels: ["gpt-oss:120b"],
    keyEnv: ["OLLAMA_API_KEY"],
    requiresKey: true, paidOnly: false, contextTokens: 131_072, maxOutputTokens: 16_384, timeout: 300, rpm: 10,
    keyUrl: "https://ollama.com/settings/keys",
    description: "Paket Free untuk model starter, 1 permintaan bersamaan; prompt tidak dicatat atau dilatih.",
  }),
  custom: preset({
    label: "Server OpenAI-compatible lain",
    baseUrl: null,
    defaultModel: null,
    fallbackModels: [],
    keyEnv: [],
    requiresKey: false, paidOnly: false, custom: true, contextTokens: 32_768, maxOutputTokens: 4096, timeout: 300, rpm: null,
    keyUrl: null,
    description: "Server Anda sendiri (mis. Hermes, LM Studio, vLLM, llama.cpp). Wajib base URL dan model; key opsional.",
  }),
});

export const REASONING_EFFORTS = Object.freeze(["none", "minimal", "low", "medium", "high"]);

/** Per-provider settings in the order they are stored, with the engine's variable suffix. */
export const PROVIDER_FIELDS = Object.freeze({
  baseUrl: "BASE_URL",
  model: "MODEL",
  fallbackModels: "FALLBACK_MODELS",
  reasoningEffort: "REASONING_EFFORT",
  contextTokens: "CONTEXT_TOKENS",
  maxOutputTokens: "MAX_OUTPUT_TOKENS",
  timeout: "TIMEOUT",
  rpm: "RPM",
  maxRetries: "MAX_RETRIES",
  temperature: "TEMPERATURE",
  jsonMode: "JSON_MODE",
  httpReferer: "HTTP_REFERER",
  appTitle: "APP_TITLE",
});

// Numeric ranges from llm.py (LLMConfig.__post_init__ / _provider_config).
// rpm 0 means "no client-side limit" (the engine's RPM=off).
export const NUMBER_RULES = Object.freeze({
  contextTokens: Object.freeze({ integer: true, min: 512, max: 10_000_000, label: "Konteks token" }),
  maxOutputTokens: Object.freeze({ integer: true, min: 1, max: 1_000_000, label: "Token output maksimum" }),
  timeout: Object.freeze({ integer: false, min: 0, minExclusive: true, max: 3600, label: "Timeout" }),
  rpm: Object.freeze({ integer: false, min: 0, max: 100_000, label: "Batas permintaan/menit" }),
  maxRetries: Object.freeze({ integer: true, min: 0, max: 10, label: "Jumlah percobaan ulang" }),
  temperature: Object.freeze({ integer: false, min: 0, max: 2, label: "Temperature" }),
});

export const MAX_FALLBACK_MODELS = 20;
const OFF_WORDS = new Set(["none", "off", "-"]);
const VALID_MODEL = /^[^\s\x00-\x1f\x7f]{1,200}$/u;
const KEY_SHAPE = /^[\x21-\x7e]{1,4096}$/;
const TITLE_SHAPE = /^[\x20-\x7e]{1,100}$/;
const LOCAL_HTTP_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "host.docker.internal"]);
const BLOCKED_HOSTNAMES = new Set([
  "metadata", "metadata.google.internal", "metadata.goog", "instance-data", "instance-data.ec2.internal",
]);
const HOST_NAME = /^[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_.])?$/;

export function scopedEnvName(provider, suffix) {
  return `POTONGIN_LLM_${provider.toUpperCase().replace(/-/g, "_")}_${suffix}`;
}

export function isProviderName(value) {
  return typeof value === "string" && PROVIDER_NAMES.includes(value);
}

export function isFreeModel(provider, model) {
  if (LLM_PRESETS[provider]?.paidOnly) return false;
  if (provider === "openrouter") return model.endsWith(":free") || model === "openrouter/free";
  return true;
}

function ipv4Octets(text) {
  const parts = text.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.map(Number);
}

function ipv6Groups(text) {
  let body = text.toLowerCase();
  const tail = [];
  const lastColon = body.lastIndexOf(":");
  if (lastColon < 0) return null;
  const last = body.slice(lastColon + 1);
  if (last.includes(".")) {
    // An embedded dotted IPv4 tail ("::ffff:169.254.1.1") counts as two groups.
    const octets = ipv4Octets(last);
    if (!octets) return null;
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    body = body.slice(0, lastColon + 1);
    if (!body.endsWith("::")) body = body.slice(0, -1);
  }
  const halves = body.split("::");
  if (halves.length > 2) return null;
  const parse = (part) => (part === "" ? [] : part.split(":"));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if ([...head, ...rest].some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  const explicit = head.length + rest.length + tail.length;
  if (halves.length === 1 ? explicit !== 8 : explicit > 7) return null;
  const zeros = new Array(8 - explicit).fill(0);
  return [...head.map((g) => parseInt(g, 16)), ...zeros, ...rest.map((g) => parseInt(g, 16)), ...tail];
}

/**
 * True for link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10,
 * fd00:ec2::254, 100.100.100.200 and their IPv4-mapped forms). Accepts a plain
 * IP address (no brackets).
 */
export function isBlockedAddress(address) {
  if (typeof address !== "string") return false;
  const v4 = ipv4Octets(address);
  if (v4) return (v4[0] === 169 && v4[1] === 254) || address === "100.100.100.200";
  const groups = ipv6Groups(address.replace(/%.*$/, ""));
  if (!groups) return false;
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if (groups[0] === 0xfd00 && groups[1] === 0x0ec2 && groups.slice(2, 7).every((g) => g === 0) && groups[7] === 0x254) return true;
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d).
  const embedsV4 = (groups.slice(0, 5).every((g) => g === 0) && (groups[5] === 0xffff || groups[5] === 0))
    || (groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0));
  if (embedsV4) return isBlockedAddress(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  return false;
}

/** True for a hostname (as URL#hostname prints it) that must never be contacted. */
export function isBlockedHost(hostname) {
  if (typeof hostname !== "string" || !hostname) return true;
  const host = hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return isBlockedAddress(host.slice(1, -1));
  return BLOCKED_HOSTNAMES.has(host.replace(/\.$/, "")) || isBlockedAddress(host);
}

/**
 * Why `raw` cannot be a provider base URL, in Indonesian, or null when it can.
 * Never echoes the URL. At least as strict as llm.py _base_url_problem: https,
 * or http only for localhost / 127.0.0.1 / [::1] / host.docker.internal; no
 * credentials, query or fragment; plus no link-local or metadata host, and the
 * host must already be in canonical form (no 127.1 or decimal-IP tricks).
 */
export function baseUrlProblem(raw) {
  if (typeof raw !== "string" || !raw || raw.length > 2048 || /[\s\x00-\x1f\x7f]/u.test(raw)) {
    return "harus berupa URL http(s) tanpa spasi";
  }
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)(.*)$/is.exec(raw);
  if (!match) return "bukan URL yang valid";
  const scheme = match[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") return "harus diawali https:// (atau http:// untuk server lokal)";
  const authority = match[2];
  if (authority.includes("@")) return "tidak boleh berisi kredensial (user:...@)";
  if (/[?#]/.test(match[3])) return "tidak boleh berisi query string atau fragment";
  let url;
  try { url = new URL(raw); } catch { return "bukan URL yang valid"; }
  const hostPart = authority.startsWith("[")
    ? authority.slice(0, authority.indexOf("]") + 1)
    : authority.replace(/:\d*$/, "");
  const host = hostPart.toLowerCase();
  if (!host || host !== url.hostname) return "bukan URL yang valid (tulis nama host atau IP secara lengkap)";
  if (!host.startsWith("[") && !HOST_NAME.test(host)) return "bukan URL yang valid";
  if (scheme === "http" && !LOCAL_HTTP_HOSTS.has(host)) {
    return "http:// hanya diizinkan untuk localhost, 127.0.0.1, [::1], atau host.docker.internal; pakai https://";
  }
  if (isBlockedHost(host)) return "tidak boleh mengarah ke alamat link-local atau metadata cloud";
  return null;
}

export function modelProblem(raw) {
  if (typeof raw !== "string") return "harus berupa teks";
  if (!VALID_MODEL.test(raw)) return "harus berupa ID model tanpa spasi (maks. 200 karakter)";
  if (raw.includes(",")) return "tidak boleh berisi koma";
  return null;
}

export function fallbackModelProblem(raw) {
  const problem = modelProblem(raw);
  if (problem) return problem;
  if (OFF_WORDS.has(raw.toLowerCase())) return "nama model 'none', 'off', atau '-' tidak bisa dipakai sebagai cadangan";
  return null;
}

export function apiKeyProblem(raw) {
  if (typeof raw !== "string" || !KEY_SHAPE.test(raw)) return "API key harus berupa teks ASCII tanpa spasi (maks. 4096 karakter)";
  return null;
}

export function numberProblem(field, value) {
  const rule = NUMBER_RULES[field];
  if (!rule) return "kolom angka tidak dikenal";
  if (typeof value !== "number" || !Number.isFinite(value)) return "harus berupa angka";
  if (rule.integer && !Number.isInteger(value)) return "harus bilangan bulat";
  const low = rule.minExclusive ? value <= rule.min : value < rule.min;
  if (low || value > rule.max) {
    return rule.minExclusive ? `harus lebih dari ${rule.min} dan maksimal ${rule.max}` : `harus antara ${rule.min} dan ${rule.max}`;
  }
  return null;
}

export function httpRefererProblem(raw) {
  if (typeof raw !== "string" || !TITLE_SHAPE.test(raw) || raw.includes(" ") || !/^https?:\/\//.test(raw)) {
    return "harus berupa URL http(s) tanpa spasi (maks. 100 karakter)";
  }
  return null;
}

export function appTitleProblem(raw) {
  if (typeof raw !== "string" || !TITLE_SHAPE.test(raw)) return "harus teks ASCII biasa (maks. 100 karakter)";
  return null;
}

export function reasoningEffortProblem(raw) {
  return REASONING_EFFORTS.includes(raw) ? null : `harus salah satu: ${REASONING_EFFORTS.join(", ")}`;
}
