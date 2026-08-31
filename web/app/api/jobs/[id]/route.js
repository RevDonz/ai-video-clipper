import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireAuth } from "../../../../lib/auth.mjs";
import { serializePublicJob } from "../../../../lib/jobs.mjs";
import { JobNotFoundError, purgeDeletedJobs, requestJobDeletion } from "../../../../lib/job-deletion.mjs";
import { sameOriginMutation } from "../../../../lib/request-security.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const response = (body, status = 200) => Response.json(body, {
  status,
  headers: { "Cache-Control": "no-store" },
});

function noStore(denied) {
  const headers = new Headers(denied.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(denied.body, {
    status: denied.status,
    statusText: denied.statusText,
    headers,
  });
}

export async function GET(request, { params }) {
  const denied = requireAuth(request);
  if (denied) return noStore(denied);
  const { id } = await params;
  if (!UUID.test(id)) return response({ error: "Job ID tidak valid" }, 400);
  try {
    const root = path.resolve(process.env.JOBS_ROOT || "/data/jobs");
    const job = JSON.parse(await readFile(path.join(root, id, "job.json"), "utf8"));
    return response({ job: serializePublicJob(job) });
  } catch (error) {
    if (error?.code === "ENOENT") return response({ error: "Job tidak ditemukan" }, 404);
    return response({ error: "Detail job tidak dapat dibaca" }, 500);
  }
}

// Deletion is asynchronous on purpose. A running job holds a fenced lease and a
// render worker may be writing into it, so the request revokes the lease, marks
// the job, and lets the purge reclaim the bytes once those workers have stopped.
// Terminal jobs have no live lease, so the immediate purge below usually
// finishes the job off within this same request.
export async function DELETE(request, { params }) {
  const denied = requireAuth(request);
  if (denied) return noStore(denied);
  if (!sameOriginMutation(request)) {
    return response({ error: "Origin permintaan tidak diizinkan", code: "csrf_rejected" }, 403);
  }
  const { id } = await params;
  if (!UUID.test(id)) return response({ error: "Job ID tidak valid" }, 400);
  const root = path.resolve(process.env.JOBS_ROOT || "/data/jobs");
  try {
    const { job } = await requestJobDeletion(root, id);
    let removed = false;
    try {
      removed = (await purgeDeletedJobs(root)).purged.includes(id);
    } catch {
      // The scheduled purge in the primary worker retries; the job is already
      // marked, so the bytes are reclaimed even if this attempt could not run.
    }
    return response({ job: serializePublicJob(job), removed }, 202);
  } catch (error) {
    if (error instanceof JobNotFoundError) return response({ error: "Job tidak ditemukan" }, 404);
    return response({ error: "Proyek tidak dapat dihapus", code: "delete_failed" }, 500);
  }
}
