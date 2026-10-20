// "Batalkan" on the dashboard and the project page (components/CancelJob.jsx). Client-safe.

const CANCELLABLE = new Set(["queued", "preparing", "downloading", "processing"]);

/** Whether `job` is queued or running, the only states a person can cancel. */
export function jobCancellable(job) {
  return CANCELLABLE.has(job?.status);
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

/**
 * POST /api/jobs/:id/cancel. `cancelled` and `finished` carry the job as the server has it now
 * (a job that finished first is shown as it ended); `redirect` when the session expired.
 */
export async function cancelJob(id, { fetchImpl = fetch, next = "/dashboard" } = {}) {
  let response;
  try {
    response = await fetchImpl(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    return { type: "error", message: "Server tidak terjangkau. Periksa koneksi, lalu coba lagi." };
  }
  if (response.status === 401) return { type: "redirect", location: `/login?next=${encodeURIComponent(next)}` };
  const payload = await readJson(response);
  const job = payload?.job && typeof payload.job === "object" ? payload.job : null;
  if (response.ok && job) return { type: "cancelled", job };
  if (response.status === 409 && job) {
    const message = payload.code === "job_deleting" ? "Proyek ini sedang dihapus." : "Proses sudah selesai lebih dulu.";
    return { type: "finished", job, message };
  }
  if (response.status === 404) return { type: "error", message: "Proyek ini tidak ada atau sudah dihapus." };
  return { type: "error", message: "Proses tidak bisa dibatalkan. Coba lagi." };
}
