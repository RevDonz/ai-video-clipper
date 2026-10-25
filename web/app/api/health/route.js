import { withErrorCodes } from "../../../lib/api-error-response.mjs";

export const dynamic = "force-dynamic";

async function handleGET() {
  return Response.json({ status: "ok", service: "ai-video-clipper-web" });
}

export const GET = withErrorCodes(handleGET);
