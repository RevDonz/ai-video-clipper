import { requireAuth } from "../../../../../lib/auth.mjs";
import {
  CandidatesArtifactInvalidError,
  CandidatesJobNotFoundError,
  isCandidateJobId,
  readCandidatesPresentation,
} from "../../../../../lib/candidates.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const response = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" },
});

export async function GET(request, { params }) {
  const denied = requireAuth(request);
  if (denied) return denied;
  const { id } = await params;
  if (!isCandidateJobId(id)) return response({ error: "Job ID tidak valid" }, 400);
  try {
    return response(await readCandidatesPresentation(id));
  } catch (error) {
    if (error instanceof CandidatesJobNotFoundError) return response({ error: "Job tidak ditemukan" }, 404);
    if (error instanceof CandidatesArtifactInvalidError) return response({ error: "Artifact kandidat tidak valid" }, 422);
    return response({ error: "Artifact kandidat tidak dapat dibaca" }, 500);
  }
}
