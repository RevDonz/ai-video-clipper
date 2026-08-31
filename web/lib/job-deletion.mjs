// User-initiated job deletion.
//
// The retention policy forbids the application from ever expiring, evicting or
// cleaning up jobs on its own. This module is the one exception the operator
// asked for, and it is explicit end to end: a person presses delete, the job is
// marked, and only then are its bytes removed.
//
// Deleting a running job cannot simply unlink the directory. The primary runner
// holds a fenced lease and writes into the job as it works, and the Python
// render worker may be rendering into it. Both already stop themselves when
// their lease stops validating: the runner's next fenced write raises
// LeaseLostError and terminates its process group, and the render worker's
// heartbeat sets its `lost` event. So deletion revokes the lease and then waits
// out the window in which those two are guaranteed to have noticed, instead of
// inventing a second cancellation protocol.

import { constants } from "node:fs";
import { open, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";

import { durableWriteJson, withPrimaryQueueLock } from "./primary-job-queue.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DELETING_STATUS = "deleting";
export const RENDER_LEASE_GRACE_MS = 300_000;
const TOMBSTONE_DIR = ".deletions";
const RENDER_RESERVATION_DIR = ".render-reservations";
const PRIMARY_RESERVATION_DIR = ".primary-reservations";
const MAX_STATE_BYTES = 2 * 1024 * 1024;

export class JobNotFoundError extends Error {
  constructor(message = "Job tidak ditemukan") {
    super(message);
    this.name = "JobNotFoundError";
  }
}

async function readNoFollowJson(target) {
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_STATE_BYTES) throw new Error("Unsafe deletion state file");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}

const tombstonePath = (root, id) => path.join(root, TOMBSTONE_DIR, `${id}.json`);

export function purgeBlockedReason({ safeAfter, renderReservations = [], now, renderLeaseGraceMs = RENDER_LEASE_GRACE_MS }) {
  const safeAt = typeof safeAfter === "string" ? Date.parse(safeAfter) : safeAfter;
  if (Number.isFinite(safeAt) && safeAt > now) return "primary_lease_live";
  for (const reservation of renderReservations) {
    const heartbeatAt = Date.parse(reservation?.heartbeatAt ?? "");
    if (!Number.isFinite(heartbeatAt)) continue;
    if (now - heartbeatAt < renderLeaseGraceMs) return "render_reservation_live";
  }
  return null;
}

// Marks the job deleted and revokes any live lease. Keeping the moment the old
// lease would have expired is what makes the wait safe: the runner heartbeats at
// a third of the lease and escalates to SIGKILL five seconds after SIGTERM, so
// it is long gone by then.
export async function requestJobDeletion(jobsRoot, id, { now = Date.now() } = {}) {
  if (!UUID.test(id || "")) throw new JobNotFoundError();
  const root = path.resolve(jobsRoot);
  return withPrimaryQueueLock(root, async () => {
    const jobPath = path.join(root, id, "job.json");
    let job;
    try {
      job = await readNoFollowJson(jobPath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new JobNotFoundError();
      throw error;
    }
    if (!job || job.id !== id) throw new JobNotFoundError();

    const leaseExpiresAt = Date.parse(job.queue?.lease?.expiresAt ?? "");
    const safeAfter = new Date(Number.isFinite(leaseExpiresAt) ? Math.max(leaseExpiresAt, now) : now).toISOString();
    const deletion = { requestedAt: new Date(now).toISOString(), safeAfter, previousStatus: job.status };

    await durableWriteJson(tombstonePath(root, id), { version: 1, id, ...deletion });

    const queue = job.queue === undefined
      ? undefined
      : { version: 1, attempts: job.queue.attempts ?? 0 };
    const next = {
      ...job,
      status: DELETING_STATUS,
      stage: DELETING_STATUS,
      stageDetail: "Proyek sedang dihapus dari penyimpanan server",
      deletion,
      updatedAt: new Date(now).toISOString(),
      ...(queue === undefined ? {} : { queue }),
    };
    await durableWriteJson(jobPath, next);
    return { job: next };
  });
}

async function listRenderReservations(root, jobId) {
  const directory = path.join(root, RENDER_RESERVATION_DIR);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const reservations = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const target = path.join(directory, entry.name);
    let value;
    try {
      value = await readNoFollowJson(target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      // A reservation we cannot read must not pin the job forever; storage
      // accounting rejects it independently.
      continue;
    }
    if (value?.jobId !== jobId) continue;
    reservations.push({ ...value, path: target });
  }
  return reservations;
}

async function purgeOne(root, id, now, renderLeaseGraceMs) {
  let tombstone;
  try {
    tombstone = await readNoFollowJson(tombstonePath(root, id));
  } catch (error) {
    if (error?.code === "ENOENT") return { purged: false, reason: "gone" };
    throw error;
  }
  const reservations = await listRenderReservations(root, id);
  const reason = purgeBlockedReason({
    safeAfter: tombstone.safeAfter,
    renderReservations: reservations,
    now,
    renderLeaseGraceMs,
  });
  if (reason) return { purged: false, reason };

  // Reservation records first. They are the only artefacts that outlive the job
  // directory as a permanent overcount: storage accounting resolves each render
  // reservation through a file inside the job, so a stranded record would be
  // charged against the quota forever.
  for (const reservation of reservations) {
    await unlink(reservation.path).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  }
  await unlink(path.join(root, PRIMARY_RESERVATION_DIR, `${id}.json`))
    .catch((error) => { if (error?.code !== "ENOENT") throw error; });

  await rm(path.join(root, id), { recursive: true, force: true });
  await unlink(tombstonePath(root, id)).catch((error) => { if (error?.code !== "ENOENT") throw error; });
  return { purged: true };
}

export async function purgeDeletedJobs(jobsRoot, { now = Date.now(), renderLeaseGraceMs = RENDER_LEASE_GRACE_MS } = {}) {
  const root = path.resolve(jobsRoot);
  const directory = path.join(root, TOMBSTONE_DIR);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { purged: [], pending: [] };
    throw error;
  }

  const purged = [];
  const pending = [];
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) continue;
    const id = entry.name.slice(0, -".json".length);
    if (!UUID.test(id)) continue;
    const result = await withPrimaryQueueLock(root, () => purgeOne(root, id, now, renderLeaseGraceMs));
    if (result.purged || result.reason === "gone") purged.push(id);
    else pending.push({ id, reason: result.reason });
  }
  return { purged, pending };
}
