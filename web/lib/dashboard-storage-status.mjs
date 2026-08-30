import { toStorageStatusDto } from "./storage-status-dto.mjs";

const BLOCK_CODES = new Set(["storage_quota_exhausted", "storage_free_space_low"]);
const UNAVAILABLE = { allowed: false, code: "storage_admission_unavailable" };

export function storageStatusView(admission) {
  const knownAllowed = admission?.allowed === true && (admission.code === null || admission.code === undefined);
  const submitBlocked = admission?.allowed === false && BLOCK_CODES.has(admission.code);
  return {
    admission: knownAllowed || submitBlocked ? admission : UNAVAILABLE,
    warning: !knownAllowed,
    submitBlocked,
    unavailable: !knownAllowed && !submitBlocked,
  };
}

async function requestStorageStatus(fetchImpl, signal) {
  try {
    const response = await fetchImpl("/api/storage/status", { cache: "no-store", signal });
    if (!response || (!response.ok && response.status !== 507)) return UNAVAILABLE;
    const payload = await response.json();
    return toStorageStatusDto(payload?.admission);
  } catch {
    return UNAVAILABLE;
  }
}

export function createStorageStatusRecovery({
  fetchImpl,
  onChange,
  schedule = setTimeout,
  cancel = clearTimeout,
  delays = [5_000, 15_000, 30_000],
}) {
  let timer = null;
  let attempt = 0;
  let disposed = false;
  let generation = 0;
  let requestController = null;

  const clearTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };

  const poll = async (currentGeneration) => {
    if (disposed || currentGeneration !== generation) return;
    clearTimer();
    const controller = new AbortController();
    requestController = controller;
    const admission = await requestStorageStatus(fetchImpl, controller.signal);
    if (requestController === controller) requestController = null;
    if (disposed || currentGeneration !== generation) return;
    const view = storageStatusView(admission);
    onChange(view);
    if (view.warning && attempt < delays.length) {
      const delay = delays[attempt];
      attempt += 1;
      timer = schedule(() => poll(currentGeneration), delay);
    }
  };

  const begin = async () => {
    if (disposed) return;
    generation += 1;
    const currentGeneration = generation;
    clearTimer();
    requestController?.abort();
    requestController = null;
    attempt = 0;
    await poll(currentGeneration);
  };

  return {
    async start() {
      await begin();
    },
    async retry() {
      await begin();
    },
    dispose() {
      disposed = true;
      generation += 1;
      clearTimer();
      requestController?.abort();
      requestController = null;
    },
  };
}

export async function recoverFailedJobSelection(jobId, { select, refreshJobs }) {
  select(jobId);
  try {
    await refreshJobs(jobId);
  } catch {
    // Selection remains authoritative when independent list reconciliation fails.
  }
}
