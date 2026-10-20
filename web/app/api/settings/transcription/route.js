// GET/PUT: the Pengaturan "Transkripsi" switch for Groq and its key (lib/transcription-settings.mjs).
// A small JSON body, so web/proxy.js runs in front; every method still checks the session itself,
// a change also its origin.
import { createTranscriptionSettingsRoute } from "../../../../lib/transcription-settings.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const route = createTranscriptionSettingsRoute();

export async function GET(request) {
  return route.GET(request);
}

export async function PUT(request) {
  return route.PUT(request);
}
