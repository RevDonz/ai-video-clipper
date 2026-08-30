import path from "node:path";

import { requireAuth } from "../../../../lib/auth.mjs";
import { storageAdmissionStatus } from "../../../../lib/primary-job-queue.mjs";
import { parseStorageAdmissionConfig, StorageAdmissionError } from "../../../../lib/storage-admission.mjs";
import { toStorageStatusDto } from "../../../../lib/storage-status-dto.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "no-store" };

async function loadStorageStatus() {
  const config = parseStorageAdmissionConfig(process.env);
  const admission = await storageAdmissionStatus(path.resolve(process.env.JOBS_ROOT || "/data/jobs"), config);
  return {
    ...admission,
    quotaBytes: admission.quotaBytes ?? config.quotaBytes,
    minimumFreeBytes: admission.minimumFreeBytes ?? config.minimumFreeBytes,
    activeReserveBytes: admission.activeReserveBytes ?? config.activeReserveBytes,
  };
}

export function createStorageStatusHandler({ authorize = requireAuth, loadStatus = loadStorageStatus } = {}) {
  return async function storageStatusHandler(request) {
    const denied = authorize(request);
    if (denied) {
      denied.headers.set("Cache-Control", "no-store");
      return denied;
    }
    try {
      const admission = toStorageStatusDto(await loadStatus());
      return Response.json({ admission }, { headers: NO_STORE });
    } catch (error) {
      const known = error instanceof StorageAdmissionError;
      const code = known && ["storage_quota_exhausted", "storage_free_space_low"].includes(error.code)
        ? error.code
        : "storage_admission_unavailable";
      const status = code === "storage_admission_unavailable" ? 503 : 507;
      return Response.json({ admission: { allowed: false, code } }, { status, headers: NO_STORE });
    }
  };
}

export const GET = createStorageStatusHandler();
