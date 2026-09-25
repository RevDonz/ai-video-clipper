// Browser client for the Konteks Tren UI routes (spec §3.2). Session cookie +
// same-origin only; the machine routes (/api/ingest/trends, Bearer token) are
// never called from the page. Every method resolves to
//   { ok, status, data, error, field }
// where `error` is a short Indonesian message and `data` is normalized for
// display. An aborted request rejects with the AbortError, like fetch.

import {
  apiErrorMessage,
  createdTokenFrom,
  normalizeTokenList,
  normalizeTrendItem,
  normalizeTrendList,
} from "../../lib/trend-view.mjs";

export const TREND_ROUTES = Object.freeze({
  trends: "/api/context/trends",
  settings: "/api/context/trends/settings",
  tokens: "/api/context/tokens",
});

const UNRECOGNIZED = "Respons server tidak dikenali. Muat ulang halaman.";
const EDITABLE_FIELDS = new Set(["kind", "title", "summary", "keywords", "hashtags", "platforms", "score", "sensitivity", "expiresAt", "enabled", "label"]);

const LABEL_CODES = new Set(["invalid_label", "label_taken"]);

// The form field to mark: `field`, else the first 422 issue on a field the form shows
// (the API names list entries as "keywords[1]"), else "label" for a token label error.
function failedField(payload) {
  if (!payload || typeof payload !== "object") return null;
  if (EDITABLE_FIELDS.has(payload.field)) return payload.field;
  for (const issue of Array.isArray(payload.issues) ? payload.issues : []) {
    const name = typeof issue?.field === "string" ? issue.field.replace(/[[.].*$/, "") : "";
    if (EDITABLE_FIELDS.has(name)) return name;
  }
  return LABEL_CODES.has(payload.code) ? "label" : null;
}

function itemFrom(payload) {
  if (!payload || typeof payload !== "object") return null;
  return normalizeTrendItem(payload.item && typeof payload.item === "object" ? payload.item : payload);
}

export function createTrendApi(fetchImpl = (...args) => globalThis.fetch(...args)) {
  async function send(url, { method = "GET", body, signal } = {}) {
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetchImpl(url, {
        method,
        cache: "no-store",
        credentials: "same-origin",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return { ok: false, status: 0, payload: null };
    }
    let payload = null;
    if (response.status !== 204) {
      try { payload = await response.json(); } catch { payload = null; }
    }
    return { ok: response.ok, status: response.status, payload };
  }

  function failure(result, fallback) {
    return { ok: false, status: result.status, data: null, error: apiErrorMessage(result, fallback), field: failedField(result.payload) };
  }

  function success(result, data) {
    return { ok: true, status: result.status, data, error: null, field: null };
  }

  const itemUrl = (id) => `${TREND_ROUTES.trends}/${encodeURIComponent(id)}`;
  const tokenUrl = (id) => `${TREND_ROUTES.tokens}/${encodeURIComponent(id)}`;

  return {
    async loadTrends(options = {}) {
      const result = await send(TREND_ROUTES.trends, options);
      if (!result.ok) return failure(result, "Konteks tren tidak bisa dimuat.");
      const data = normalizeTrendList(result.payload);
      return data ? success(result, data) : { ...failure(result, UNRECOGNIZED), error: UNRECOGNIZED };
    },

    async createTrend(input) {
      const result = await send(TREND_ROUTES.trends, { method: "POST", body: input });
      return result.ok ? success(result, itemFrom(result.payload)) : failure(result, "Tren belum tersimpan.");
    },

    async updateTrend(id, patch) {
      const result = await send(itemUrl(id), { method: "PATCH", body: patch });
      return result.ok ? success(result, itemFrom(result.payload)) : failure(result, "Perubahan belum tersimpan.");
    },

    async deleteTrend(id) {
      const result = await send(itemUrl(id), { method: "DELETE" });
      return result.ok ? success(result, null) : failure(result, "Tren belum terhapus.");
    },

    async setEnabled(enabled) {
      const result = await send(TREND_ROUTES.settings, { method: "PUT", body: { enabled } });
      if (!result.ok) return failure(result, "Pengaturan belum tersimpan.");
      const saved = typeof result.payload?.enabled === "boolean" ? result.payload.enabled : enabled;
      return success(result, { enabled: saved });
    },

    async loadTokens(options = {}) {
      const result = await send(TREND_ROUTES.tokens, options);
      if (!result.ok) return failure(result, "Daftar token tidak bisa dimuat.");
      const tokens = normalizeTokenList(result.payload);
      return tokens ? success(result, tokens) : { ...failure(result, UNRECOGNIZED), error: UNRECOGNIZED };
    },

    async createToken(label) {
      const result = await send(TREND_ROUTES.tokens, { method: "POST", body: { label } });
      if (!result.ok) return failure(result, "Token belum dibuat.");
      const created = createdTokenFrom(result.payload);
      if (!created) return { ok: false, status: result.status, data: null, error: "Server tidak mengembalikan token yang valid. Muat ulang daftar token.", field: null };
      return success(result, created);
    },

    async revokeToken(id) {
      const result = await send(tokenUrl(id), { method: "DELETE" });
      return result.ok ? success(result, null) : failure(result, "Token belum dicabut.");
    },
  };
}
