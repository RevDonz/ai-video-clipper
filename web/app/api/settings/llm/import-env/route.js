import { requireAuth } from "../../../../../lib/auth.mjs";
import {
  HttpBodyError,
  MAX_ACTION_BODY_BYTES,
  errorResponse,
  guardRequest,
  noStore,
  readJsonBody,
} from "../../../../../lib/llm-settings-http.mjs";
import {
  hasLlmEnv,
  importEnvToFile,
  publicSettingsView,
  readEffectiveLlmStatus,
  settingsSecret,
} from "../../../../../lib/llm-settings.mjs";
import { sameOriginMutation } from "../../../../../lib/request-security.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One-click migration: seals the keys and settings this server's environment
// (.env) already has into the settings file. Refuses to overwrite unless
// { force: true }.
export function createLlmImportRoute({ authorize = requireAuth, env = process.env, sameOrigin = sameOriginMutation } = {}) {
  return {
    async POST(request) {
      const denied = guardRequest(request, { authorize, sameOrigin, mutation: true });
      if (denied) return denied;
      try {
        const body = await readJsonBody(request, { maxBytes: MAX_ACTION_BODY_BYTES, emptyValue: {} });
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((name) => name !== "force")
            || (body.force !== undefined && typeof body.force !== "boolean")) {
          throw new HttpBodyError(400, "Isi permintaan harus {} atau { force: true }");
        }
        if (!hasLlmEnv(env)) {
          return noStore({ error: "Server tidak punya konfigurasi LLM di environment (.env) untuk diimpor.", code: "nothing_to_import" }, 422);
        }
        const { settings, warnings } = await importEnvToFile({ env, force: body.force === true });
        return noStore({
          settings: publicSettingsView(settings, { secret: settingsSecret(env), source: "ui" }),
          warnings,
          status: await readEffectiveLlmStatus(env, { read: { exists: true, settings } }),
        });
      } catch (error) {
        if (error?.code === "exists") {
          return noStore({ error: "Pengaturan AI sudah ada, jadi impor dibatalkan supaya tidak menimpa perubahan Anda.", code: "exists" }, 409);
        }
        return errorResponse(error);
      }
    },
  };
}

const route = createLlmImportRoute();

export async function POST(request) {
  return route.POST(request);
}
