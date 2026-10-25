import { requireAuth } from "../../../../lib/auth.mjs";
import { noStore } from "../../../../lib/llm-settings-http.mjs";
import { readSystemInfo } from "../../../../lib/system-info.mjs";
import { withErrorCodes } from "../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// GET: the tools this server runs, for Pengaturan "Tentang sistem". Read-only; unknown values
// are null. No network call, no path and no host in the answer (lib/system-info.mjs).
export function createSystemInfoRoute({ authorize = requireAuth, read = readSystemInfo } = {}) {
  return {
    async GET(request) {
      const denied = authorize(request);
      if (denied) {
        denied.headers.set("Cache-Control", "no-store");
        return denied;
      }
      try {
        return noStore(await read());
      } catch {
        return noStore({ error: "Info sistem tidak bisa dibaca", code: "system_info_failed" }, 500);
      }
    },
  };
}

const route = createSystemInfoRoute();

async function handleGET(request) {
  return route.GET(request);
}

export const GET = withErrorCodes(handleGET);
