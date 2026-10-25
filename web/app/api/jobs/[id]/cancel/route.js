import path from "node:path";

import { requireAuth } from "../../../../../lib/auth.mjs";
import { serializePublicJob } from "../../../../../lib/jobs.mjs";
import { cancelPrimaryJob } from "../../../../../lib/primary-job-queue.mjs";
import { sameOriginMutation } from "../../../../../lib/request-security.mjs";
import { withErrorCodes } from "../../../../../lib/api-error-response.mjs";

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
  return new Response(denied.body, { status: denied.status, statusText: denied.statusText, headers });
}

// "Batalkan" on a queued or running job. The answer is immediate: the job is marked cancelled
// and its lease revoked under the queue lock, and the runner stops its processes within seconds
// (scripts/run-job.mjs). Cancelling twice answers the same; a finished job is left alone (409).
async function handlePOST(request, { params }) {
  const denied = requireAuth(request);
  if (denied) return noStore(denied);
  if (!sameOriginMutation(request)) {
    return response({ error: "Origin permintaan tidak diizinkan", code: "csrf_rejected" }, 403);
  }
  const { id } = await params;
  if (!UUID.test(id)) return response({ error: "Job ID tidak valid", code: "job_id_invalid", messageId: "web.job_id_invalid" }, 400);
  const root = path.resolve(process.env.JOBS_ROOT || "/data/jobs");
  let result;
  try {
    result = await cancelPrimaryJob({ jobsRoot: root, id });
  } catch {
    return response({ error: "Proses tidak bisa dibatalkan. Coba lagi.", code: "cancel_failed" }, 500);
  }
  switch (result.outcome) {
    case "cancelled":
    case "already_cancelled":
      return response({ job: serializePublicJob(result.job), cancelled: true });
    case "finished":
      return response({
        error: "Proses sudah selesai, tidak ada yang dibatalkan",
        code: "job_finished",
        cancelled: false,
        job: serializePublicJob(result.job),
      }, 409);
    case "deleting":
      return response({
        error: "Proyek sedang dihapus",
        code: "job_deleting",
        cancelled: false,
        job: serializePublicJob(result.job),
      }, 409);
    default:
      return response({ error: "Job tidak ditemukan", code: "job_not_found", messageId: "web.job_not_found" }, 404);
  }
}

export const POST = withErrorCodes(handlePOST);
