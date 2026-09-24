// Provider actions behind the settings page: a real connection check through
// the Python engine, and the provider's model list fetched server-side. Keys
// are only ever handed to the engine child process (for its one provider) or
// sent to that provider's own base URL; results carry codes and fixed texts.

import { execFile } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import https from "node:https";

import {
  LLM_PRESETS,
  baseUrlProblem,
  isBlockedAddress,
  isProviderName,
  modelProblem,
  scopedEnvName,
} from "./llm-presets.mjs";
import {
  KEY_UNREADABLE_MESSAGE,
  LlmSettingsError,
  buildLlmEnv,
  effectiveSettings,
  engineProcessEnv,
  providerKey,
} from "./llm-settings.mjs";

export const CHECK_TIMEOUT_MS = 120_000;
export const CHECK_REQUEST_TIMEOUT_S = 45;
export const MODELS_TIMEOUT_MS = 15_000;
export const MODELS_MAX_BYTES = 4 * 1024 * 1024;
export const MAX_LISTED_MODELS = 500;
const MAX_CHECK_OUTPUT_BYTES = 256 * 1024;
const CODE = /^[a-z][a-z0-9_]{0,40}$/;
// What the page shows as a model name (llm-status.mjs uses the same subset).
const DISPLAY_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;

export class LlmActionError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "LlmActionError";
    this.code = code;
    this.status = status;
  }
}

const CHECK_MESSAGES = Object.freeze({
  ok: "Terhubung: model menjawab JSON dengan benar.",
  auth: "API key ditolak penyedia (401/403). Periksa atau ganti key.",
  missing_api_key: "API key belum diisi.",
  key_unreadable: KEY_UNREADABLE_MESSAGE,
  not_free: "Mode hanya-gratis aktif, tetapi penyedia/model ini berbayar.",
  config_invalid: "Konfigurasi penyedia ini tidak valid.",
  unknown_provider: "Nama penyedia tidak dikenal oleh engine.",
  not_configured: "Penyedia belum lengkap atau key tersimpan tidak bisa dibuka.",
  disabled: "AI sedang dimatikan.",
  model_not_found: "Model tidak ditemukan. Pilih model lain (pakai Ambil daftar model).",
  payment_required: "Model ini butuh kredit/langganan berbayar.",
  rate_limited: "Kena rate limit penyedia. Coba lagi sebentar.",
  quota_exhausted: "Kuota gratis habis. Tunggu reset atau pakai penyedia lain.",
  network: "Server penyedia tidak bisa dihubungi. Periksa base URL dan koneksi server.",
  timeout: "Penyedia tidak menjawab dalam batas waktu tes.",
  truncated: "Jawaban terpotong. Naikkan token output maksimum atau set reasoning effort ke none.",
  bad_json: "Model menjawab, tetapi bukan JSON yang valid.",
  bad_response: "Jawaban server tidak bisa dibaca.",
  unexpected_reply: "Model menjawab JSON, tetapi bukan {\"ok\": true}.",
  context_length: "Prompt terlalu panjang untuk model ini.",
  too_large: "Permintaan terlalu besar untuk penyedia ini.",
  content_filter: "Jawaban diblokir filter konten penyedia.",
});

export function checkMessage(code) {
  if (CHECK_MESSAGES[code]) return CHECK_MESSAGES[code];
  if (/^http_5\d\d$/.test(code)) return "Server penyedia sedang error (5xx). Coba lagi nanti.";
  if (/^http_\d{3}$/.test(code)) return `Penyedia menolak permintaan (HTTP ${code.slice(5)}).`;
  return `Tes gagal (kode: ${code}).`;
}

function safeCode(value) {
  return typeof value === "string" && CODE.test(value) ? value : "unknown";
}

function safeModel(value) {
  return typeof value === "string" && DISPLAY_MODEL.test(value) ? value : null;
}

function safeLatency(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 3600 ? Math.round(value * 1000) / 1000 : null;
}

function outcome(provider, code, { model = null, latencyS = null } = {}) {
  return { provider, status: code === null ? "ok" : "failed", model, latencyS, code, message: checkMessage(code ?? "ok") };
}

async function listedProvider(provider, env) {
  if (!isProviderName(provider)) throw new LlmSettingsError("invalid", "Penyedia tidak dikenal.", { issues: [{ field: "provider", message: "Penyedia tidak dikenal." }] });
  const { settings } = await effectiveSettings(env);
  const entry = settings.providers.find((item) => item.provider === provider);
  if (!entry) {
    throw new LlmSettingsError("invalid", "Penyedia ini belum ada di pengaturan tersimpan. Simpan dulu, lalu coba lagi.", { issues: [{ field: "provider", message: "Belum tersimpan." }] });
  }
  return { settings, entry };
}

// The engine's --check --json output for a single provider, reduced to a code.
function parseCheck(provider, stdout) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const row = Array.isArray(report.providers) ? report.providers.find((item) => item?.provider === provider) : null;
  if (row?.status === "ok") return outcome(provider, null, { model: safeModel(row.model), latencyS: safeLatency(row.latency_s) });
  const error = row?.error ?? report.error;
  if (!error || typeof error !== "object") return null;
  return outcome(provider, safeCode(error.code));
}

/**
 * Runs `python -m ai_clipper.llm --check --json` for one provider of the saved
 * settings (or the environment import when no file exists): the child sees only
 * that provider and its key, never the dashboard secrets.
 */
export async function runProviderCheck({
  provider,
  env = process.env,
  pythonBin = env.PYTHON_BIN || "python",
  timeoutMs = CHECK_TIMEOUT_MS,
  execFileImpl = execFile,
}) {
  const { settings, entry } = await listedProvider(provider, env);
  const key = providerKey(entry, env);
  if (key.present && key.value === null) return outcome(provider, "key_unreadable");
  const childEnv = engineProcessEnv(buildLlmEnv(settings, env, { only: provider }));
  const configured = entry.timeout ?? LLM_PRESETS[provider].timeout;
  childEnv[scopedEnvName(provider, "TIMEOUT")] = String(Math.min(configured, CHECK_REQUEST_TIMEOUT_S));
  childEnv[scopedEnvName(provider, "MAX_RETRIES")] = "0";
  const { error, stdout } = await new Promise((resolve) => {
    execFileImpl(
      /* turbopackIgnore: true */ pythonBin,
      ["-m", "ai_clipper.llm", "--check", "--json"],
      { env: childEnv, encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_CHECK_OUTPUT_BYTES, windowsHide: true, shell: false },
      (failure, output) => resolve({ error: failure, stdout: typeof output === "string" ? output : "" }),
    );
  });
  if (error?.code === "ENOENT" || error?.code === "EACCES") throw new LlmActionError("engine_unavailable", "Engine Python tidak tersedia di server.", 503);
  if (error && (error.killed || error.signal === "SIGKILL")) return outcome(provider, "timeout");
  const parsed = parseCheck(provider, stdout);
  if (!parsed) throw new LlmActionError("engine_error", "Engine tidak memberi hasil tes yang bisa dibaca.", 502);
  return parsed;
}

// A dns.lookup that refuses link-local and metadata addresses (the URL rules
// already refuse them as literals; this closes the DNS path, including
// rebinding, because the checked answer is the one the socket connects to).
export function createGuardedLookup(resolve = dns.lookup) {
  return function guardedLookup(hostname, options, callback) {
    const done = typeof options === "function" ? options : callback;
    const settings = typeof options === "object" && options !== null ? options : {};
    resolve(hostname, { ...settings, all: true }, (error, addresses) => {
      if (error) { done(error); return; }
      if (!Array.isArray(addresses) || !addresses.length || addresses.some((item) => isBlockedAddress(item.address))) {
        done(Object.assign(new Error("Alamat tujuan tidak diizinkan"), { code: "EBLOCKED" }));
        return;
      }
      if (settings.all) done(null, addresses);
      else done(null, addresses[0].address, addresses[0].family);
    });
  };
}

export const guardedLookup = createGuardedLookup();

function modelIds(provider, payload) {
  const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : null;
  if (!list) return null;
  const ids = [];
  for (const item of list) {
    let id = typeof item === "string" ? item : item && typeof item === "object" ? item.id ?? item.name ?? item.model : null;
    if (typeof id !== "string") continue;
    if (provider === "gemini" && id.startsWith("models/")) id = id.slice("models/".length);
    if (!modelProblem(id)) ids.push(id);
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/** GET {baseUrl}/models for one saved provider: model ids, sorted and capped. */
export async function fetchProviderModels({
  provider,
  env = process.env,
  timeoutMs = MODELS_TIMEOUT_MS,
  maxBytes = MODELS_MAX_BYTES,
  lookup = guardedLookup,
}) {
  const { entry } = await listedProvider(provider, env);
  const baseUrl = entry.baseUrl ?? LLM_PRESETS[provider].baseUrl;
  if (!baseUrl) throw new LlmSettingsError("invalid", "Base URL belum diisi.", { issues: [{ field: "baseUrl", message: "Belum diisi." }] });
  const problem = baseUrlProblem(baseUrl);
  if (problem) throw new LlmSettingsError("invalid", `Base URL ${problem}.`, { issues: [{ field: "baseUrl", message: problem }] });
  const key = providerKey(entry, env);
  if (key.present && key.value === null) throw new LlmActionError("key_unreadable", KEY_UNREADABLE_MESSAGE, 422);
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/models`);
  const transport = url.protocol === "https:" ? https : http;
  const headers = { Accept: "application/json", "User-Agent": "Potongin-AI-Clipper/1.0" };
  if (key.value) headers.Authorization = `Bearer ${key.value}`;

  const body = await new Promise((resolve, reject) => {
    let settled = false;
    let deadline = null;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    const request = transport.request(url, { method: "GET", headers, lookup, agent: false }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400) {
        response.resume();
        finish(new LlmActionError("redirect", "Server mengalihkan permintaan (redirect); tidak diikuti. Periksa base URL."));
        return;
      }
      if (status === 401 || status === 403) {
        response.resume();
        finish(new LlmActionError("auth", "API key ditolak penyedia (401/403)."));
        return;
      }
      if (status === 404) {
        response.resume();
        finish(new LlmActionError("not_found", "Server ini tidak menyediakan daftar model (/models). Isi ID model secara manual."));
        return;
      }
      if (status !== 200) {
        response.resume();
        finish(new LlmActionError("http_error", `Penyedia menjawab HTTP ${status}.`));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          request.destroy();
          finish(new LlmActionError("too_large", "Daftar model terlalu besar."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => finish(null, Buffer.concat(chunks, total)));
      response.on("error", () => finish(new LlmActionError("network", "Koneksi ke penyedia terputus.")));
    });
    deadline = setTimeout(() => {
      request.destroy();
      finish(new LlmActionError("timeout", "Penyedia tidak menjawab dalam batas waktu."));
    }, timeoutMs);
    request.on("error", (error) => {
      finish(error?.code === "EBLOCKED"
        ? new LlmActionError("blocked", "Alamat server ini tidak diizinkan (link-local/metadata).", 422)
        : new LlmActionError("network", "Server penyedia tidak bisa dihubungi. Periksa base URL."));
    });
    request.end();
  });

  let payload;
  try {
    payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new LlmActionError("bad_response", "Daftar model dari penyedia tidak bisa dibaca.");
  }
  const ids = modelIds(provider, payload);
  if (!ids) throw new LlmActionError("bad_response", "Daftar model dari penyedia tidak bisa dibaca.");
  return { provider, models: ids.slice(0, MAX_LISTED_MODELS), total: ids.length, truncated: ids.length > MAX_LISTED_MODELS };
}
