// GET/PUT: the Pengaturan "Transkripsi" switch for Groq and its key (lib/transcription-settings.mjs).
// A small JSON body, so web/proxy.js runs in front; every method still checks the session itself,
// a change also its origin.
import { createTranscriptionSettingsRoute } from "../../../../lib/transcription-settings.mjs";
import { withErrorCodes } from "../../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createTranscriptionSettingsRoute();

async function handleGET(request) {
  return route.GET(request);
}

async function handlePUT(request) {
  return route.PUT(request);
}

export const GET = withErrorCodes(handleGET);
export const PUT = withErrorCodes(handlePUT);
