import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "../../../../lib/auth.mjs";
import { enrichJobSocialMetadata } from "../../../../lib/jobs.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request, { params }) {
  const denied = requireAuth(request);
  if (denied) return denied;
  const { id } = await params;
  if (!UUID.test(id)) return Response.json({ error: "Job ID tidak valid" }, { status: 400 });
  try {
    const root = path.resolve(process.env.JOBS_ROOT || "/data/jobs");
    const job = JSON.parse(await readFile(path.join(root, id, "job.json"), "utf8"));
    const { sourcePath: _sourcePath, ...safe } = job;
    return Response.json({ job: enrichJobSocialMetadata(safe) });
  } catch {
    return Response.json({ error: "Job tidak ditemukan" }, { status: 404 });
  }
}
