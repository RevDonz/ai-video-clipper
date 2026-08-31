import { requireAuth } from "../../../../../../../lib/auth.mjs";
import {
  CaptionCuesCandidateNotFoundError,
  CaptionCuesInvalidError,
  CaptionCuesJobNotFoundError,
  CaptionCuesUnavailableError,
  isCaptionCandidateId,
  isCaptionJobId,
  readCaptionCues,
} from "../../../../../../../lib/caption-cues.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const response = (body, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET(request, { params }) {
  const denied = requireAuth(request);
  if (denied) return denied;
  const { id, candidateId } = await params;
  if (!isCaptionJobId(id)) return response({ error: "Job ID tidak valid" }, 400);
  if (!isCaptionCandidateId(candidateId)) return response({ error: "Candidate ID tidak valid" }, 400);
  try {
    return response(await readCaptionCues(id, candidateId));
  } catch (error) {
    if (error instanceof CaptionCuesJobNotFoundError || error instanceof CaptionCuesCandidateNotFoundError) {
      return response({ error: "Kandidat tidak ditemukan" }, 404);
    }
    if (error instanceof CaptionCuesInvalidError) return response({ error: "Artifact caption tidak valid" }, 422);
    if (error instanceof CaptionCuesUnavailableError) return response({ error: "Layanan caption tidak tersedia" }, 503);
    return response({ error: "Layanan caption tidak tersedia" }, 503);
  }
}
