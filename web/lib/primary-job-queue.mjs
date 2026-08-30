import crypto from "node:crypto";
import os from "node:os";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

export const ACTIVE_PRIMARY_STATUSES = Object.freeze(["queued", "preparing", "downloading", "processing"]);
const ACTIVE = new Set(ACTIVE_PRIMARY_STATUSES);
const TERMINAL = new Set(["completed", "failed"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCK_NAME = ".primary-queue.lock";
const RESERVATIONS = ".primary-reservations";
const LOCK_STALE_MS = 30_000;
const RESERVATION_STALE_MS = 60 * 60_000;

export class QueueCapacityError extends Error {
  constructor(message = "Primary job queue is at capacity") { super(message); this.name = "QueueCapacityError"; }
}
export class LeaseLostError extends Error {
  constructor(message = "Primary job lease is no longer owned by this worker") { super(message); this.name = "LeaseLostError"; }
}
export class QueueStateError extends Error {
  constructor(message = "Unsafe or unsupported primary queue state") { super(message); this.name = "QueueStateError"; }
}

function boundedInteger(raw, name, minimum, maximum) {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) throw new Error(`Invalid primary queue configuration: ${name}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid primary queue configuration: ${name}`);
  return value;
}

export function parsePrimaryQueueConfig(env = process.env) {
  const maxActiveJobs = boundedInteger(env.PRIMARY_MAX_ACTIVE_JOBS, "PRIMARY_MAX_ACTIVE_JOBS", 1, 100);
  const concurrency = boundedInteger(env.PRIMARY_WORKER_CONCURRENCY, "PRIMARY_WORKER_CONCURRENCY", 1, 16);
  const maxAttempts = boundedInteger(env.PRIMARY_MAX_ATTEMPTS, "PRIMARY_MAX_ATTEMPTS", 1, 20);
  const leaseMs = boundedInteger(env.PRIMARY_LEASE_MS, "PRIMARY_LEASE_MS", 5_000, 3_600_000);
  const legacyQuiescenceMs = env.PRIMARY_LEGACY_QUIESCENCE_MS === undefined
    ? Math.max(300_000, leaseMs * 2)
    : boundedInteger(env.PRIMARY_LEGACY_QUIESCENCE_MS, "PRIMARY_LEGACY_QUIESCENCE_MS", 60_000, 86_400_000);
  if (concurrency > maxActiveJobs) throw new Error("Invalid primary queue configuration: concurrency exceeds admission bound");
  return { maxActiveJobs, concurrency, maxAttempts, leaseMs, legacyQuiescenceMs };
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");
const contained = (root, target) => target === root || target.startsWith(`${root}${path.sep}`);

async function syncDirectory(directory) {
  const fd = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
}

async function ensureJobsRoot(jobsRoot) {
  const root = path.resolve(jobsRoot);
  await mkdir(root, { recursive: true });
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(root) !== root) throw new QueueStateError("Unsafe primary jobs root");
  return root;
}

async function readNoFollowJson(target) {
  const fd = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await fd.stat();
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new QueueStateError("Unsafe primary queue file");
    return JSON.parse(await fd.readFile("utf8"));
  } finally { await fd.close(); }
}

async function acquireQueueLock(jobsRoot, { timeoutMs = 10_000, staleMs = LOCK_STALE_MS, retryDelayMs = 10 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(staleMs) || staleMs < 1
      || !Number.isSafeInteger(retryDelayMs) || retryDelayMs < 1) throw new Error("Invalid primary queue lock configuration");
  const root = await ensureJobsRoot(jobsRoot);
  const lockPath = path.join(root, LOCK_NAME);
  const ownerPath = path.join(lockPath, "owner.json");
  const reclaimPath = path.join(lockPath, ".reclaim");
  const deadline = Date.now() + timeoutMs;
  const token = crypto.randomUUID();
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      const createdAt = new Date().toISOString();
      await durableWriteJson(ownerPath, { token, pid: process.pid, hostname: os.hostname(), createdAt, heartbeatAt: createdAt });
      const renew = async () => {
        await mkdir(reclaimPath, { mode: 0o700 });
        try {
          const owner = await readNoFollowJson(ownerPath);
          if (owner.token !== token) throw new LeaseLostError("Primary queue lock lease was lost");
          await durableWriteJson(ownerPath, { ...owner, heartbeatAt: new Date().toISOString() });
        } finally {
          await rmdir(reclaimPath).catch((error) => { if (error.code !== "ENOENT") throw error; });
        }
      };
      const controller = new AbortController();
      const heartbeatMs = Math.max(1, Math.floor(staleMs / 3));
      let stopped = false;
      let timer = null;
      let wake = null;
      let renewalFailure = null;
      const heartbeat = (async () => {
        while (!stopped) {
          await new Promise((resolve) => { wake = resolve; timer = setTimeout(resolve, heartbeatMs); });
          timer = null;
          if (stopped) break;
          try { await renew(); }
          catch (error) {
            renewalFailure ||= error;
            controller.abort(error);
          }
        }
      })();
      const stopHeartbeat = async () => {
        if (!stopped) {
          stopped = true;
          if (timer !== null) clearTimeout(timer);
          wake?.();
        }
        await heartbeat;
      };
      const release = async () => {
        await stopHeartbeat();
        let releaseFailure = null;
        let ownsReclaim = false;
        try {
          await mkdir(reclaimPath, { mode: 0o700 });
          ownsReclaim = true;
          const owner = await readNoFollowJson(ownerPath);
          if (owner.token !== token) throw new LeaseLostError("Primary queue lock lease was lost");
          await unlink(ownerPath);
          await rmdir(reclaimPath);
          ownsReclaim = false;
          await rmdir(lockPath);
          await syncDirectory(root);
        } catch (error) {
          releaseFailure = error;
          if (ownsReclaim) {
            await rmdir(reclaimPath).catch((cleanupError) => {
              if (cleanupError.code !== "ENOENT") throw cleanupError;
            });
          }
        }
        if (renewalFailure) throw new QueueStateError("Primary queue lock heartbeat failed", { cause: renewalFailure });
        if (releaseFailure instanceof LeaseLostError) throw releaseFailure;
        if (releaseFailure) throw new QueueStateError("Primary queue lock final ownership validation failed", { cause: releaseFailure });
      };
      release.release = release;
      release.renew = renew;
      release.signal = controller.signal;
      release.heartbeatMs = heartbeatMs;
      return release;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new Error("Timed out acquiring primary queue lock");
      try {
        const lockInfo = await lstat(lockPath);
        if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) throw new QueueStateError("Unsafe primary queue lock");
        let owner = null;
        try { owner = await readNoFollowJson(ownerPath); }
        catch (inspectError) { if (inspectError.code !== "ENOENT") throw inspectError; }
        const heartbeat = owner ? Date.parse(owner.heartbeatAt || owner.createdAt) : lockInfo.mtimeMs;
        if (Number.isFinite(heartbeat) && Date.now() - heartbeat > staleMs) {
          try {
            await mkdir(reclaimPath, { mode: 0o700 });
            let currentOwner = null;
            try { currentOwner = await readNoFollowJson(ownerPath); }
            catch (inspectError) { if (inspectError.code !== "ENOENT") throw inspectError; }
            const currentHeartbeat = currentOwner ? Date.parse(currentOwner.heartbeatAt || currentOwner.createdAt) : heartbeat;
            if (Number.isFinite(currentHeartbeat) && Date.now() - currentHeartbeat > staleMs) {
              const abandoned = `${lockPath}.abandoned.${crypto.randomUUID()}`;
              await rename(lockPath, abandoned);
              await rm(abandoned, { recursive: true, force: true });
              await syncDirectory(root);
              continue;
            }
            await rmdir(reclaimPath);
          } catch (reclaimError) {
            if (!["EEXIST", "ENOENT"].includes(reclaimError.code)) throw reclaimError;
          }
        }
      } catch (inspectError) {
        if (inspectError.code !== "ENOENT" && inspectError instanceof QueueStateError) throw inspectError;
      }
      if (Date.now() >= deadline) throw new Error("Timed out acquiring primary queue lock");
      await delay(retryDelayMs);
    }
  }
}

export async function withPrimaryQueueLock(jobsRoot, callback, options) {
  const release = await acquireQueueLock(jobsRoot, options);
  let result;
  let callbackError;
  let releaseError;
  try { result = await callback(release.signal); }
  catch (error) { callbackError = error; }
  finally {
    try { await release(); }
    catch (error) { releaseError = error; }
  }
  if (callbackError) throw callbackError;
  if (releaseError) throw releaseError;
  return result;
}

export async function durableWriteJson(target, value) {
  const directory = path.dirname(target);
  await mkdir(directory, { recursive: true });
  const pending = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const file = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await file.sync(); } finally { await file.close(); }
  try { await rename(pending, target); await syncDirectory(directory); }
  catch (error) { await rm(pending, { force: true }); throw error; }
}

function validateQueue(job) {
  if (job.queue === undefined) return;
  if (!job.queue || typeof job.queue !== "object" || Array.isArray(job.queue) || job.queue.version !== 1
      || !Number.isInteger(job.queue.attempts) || job.queue.attempts < 0) {
    throw new QueueStateError("Unsupported primary queue schema");
  }
}

function validateJobIdentity(job, directoryName) {
  if (!UUID.test(directoryName) || !job || typeof job !== "object" || job.id !== directoryName || !UUID.test(job.id)) {
    throw new QueueStateError("Invalid primary job identity");
  }
  if (typeof job.status !== "string") throw new QueueStateError("Invalid primary job status");
  validateQueue(job);
}

async function listJobs(jobsRoot) {
  const root = await ensureJobsRoot(jobsRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const jobs = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw new QueueStateError(`Unsafe primary job entry: ${entry.name}`);
    const jobRoot = path.join(root, entry.name);
    if (await realpath(jobRoot) !== jobRoot) throw new QueueStateError(`Unsafe primary job directory: ${entry.name}`);
    const jobPath = path.join(jobRoot, "job.json");
    try {
      const job = await readNoFollowJson(jobPath);
      validateJobIdentity(job, entry.name);
      jobs.push({ job, jobPath });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (error instanceof QueueStateError) throw error;
      throw new QueueStateError(`Cannot safely inspect primary queue state in ${entry.name}`, { cause: error });
    }
  }
  return jobs;
}

async function reservationCount(root, activeIds, now = Date.now()) {
  const directory = path.join(root, RESERVATIONS);
  await mkdir(directory, { mode: 0o700, recursive: true });
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !UUID.test(entry.name.replace(/\.json$/, ""))) throw new QueueStateError("Unsafe primary admission reservation");
    const target = path.join(directory, entry.name);
    const value = await readNoFollowJson(target);
    const id = entry.name.replace(/\.json$/, "");
    if (activeIds.has(id)) { await unlink(target); continue; }
    const expires = Date.parse(value.expiresAt);
    const legacyCreated = Date.parse(value.createdAt);
    if ((Number.isFinite(expires) && expires <= now)
        || (!Number.isFinite(expires) && Number.isFinite(legacyCreated) && now - legacyCreated > RESERVATION_STALE_MS)) {
      await unlink(target);
      continue;
    }
    count += 1;
  }
  await syncDirectory(directory);
  return count;
}

export async function reserveAdmission(jobsRoot, maxActiveJobs, requestedId = crypto.randomUUID()) {
  if (!Number.isSafeInteger(maxActiveJobs) || maxActiveJobs < 1) throw new Error("Invalid primary queue configuration: admission bound");
  const release = await acquireQueueLock(jobsRoot);
  try {
    const root = await ensureJobsRoot(jobsRoot);
    const jobs = await listJobs(root);
    const activeIds = new Set(jobs.filter(({ job }) => ACTIVE.has(job.status)).map(({ job }) => job.id));
    const reserved = await reservationCount(root, activeIds);
    if (activeIds.size + reserved >= maxActiveJobs) throw new QueueCapacityError();
    const id = requestedId;
    if (!UUID.test(id)) throw new QueueStateError("Invalid primary admission job ID");
    const token = crypto.randomUUID();
    const now = Date.now();
    await durableWriteJson(path.join(root, RESERVATIONS, `${id}.json`), {
      version: 1, id, tokenHash: tokenHash(token), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + RESERVATION_STALE_MS).toISOString(),
    });
    return { id, token };
  } finally { await release(); }
}

export async function renewAdmission(jobsRoot, reservation, now = Date.now()) {
  if (!reservation || !UUID.test(reservation.id || "") || typeof reservation.token !== "string") return false;
  const release = await acquireQueueLock(jobsRoot);
  try {
    const target = path.join(path.resolve(jobsRoot), RESERVATIONS, `${reservation.id}.json`);
    let current;
    try { current = await readNoFollowJson(target); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (current.tokenHash !== tokenHash(reservation.token)) return false;
    await durableWriteJson(target, { ...current, expiresAt: new Date(now + RESERVATION_STALE_MS).toISOString() });
    return true;
  } finally { await release(); }
}

export async function cancelAdmission(jobsRoot, reservation) {
  if (!reservation || !UUID.test(reservation.id || "") || typeof reservation.token !== "string") return false;
  const release = await acquireQueueLock(jobsRoot);
  try {
    const target = path.join(path.resolve(jobsRoot), RESERVATIONS, `${reservation.id}.json`);
    let current;
    try { current = await readNoFollowJson(target); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (current.tokenHash !== tokenHash(reservation.token)) return false;
    await unlink(target);
    await syncDirectory(path.dirname(target));
    return true;
  } finally { await release(); }
}

export async function publishReservedQueuedJob(jobsRoot, job, reservation) {
  if (!reservation || reservation.id !== job?.id || typeof reservation.token !== "string") throw new QueueStateError("Invalid primary admission reservation");
  const release = await acquireQueueLock(jobsRoot);
  try {
    const root = await ensureJobsRoot(jobsRoot);
    validateJobIdentity(job, reservation.id);
    if (job.status !== "queued" || job.queue !== undefined) throw new QueueStateError("Invalid queued primary job");
    const jobRoot = path.join(root, job.id);
    const jobPath = path.join(jobRoot, "job.json");
    try {
      const existing = await readNoFollowJson(jobPath);
      validateJobIdentity(existing, reservation.id);
      if (existing.queue?.version !== 1) throw new QueueStateError("Published primary job is not queue managed");
      return existing;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const reservationPath = path.join(root, RESERVATIONS, `${reservation.id}.json`);
    const persisted = await readNoFollowJson(reservationPath);
    if (persisted.tokenHash !== tokenHash(reservation.token)) throw new QueueStateError("Primary admission reservation was lost");
    if (!contained(root, jobRoot)) throw new QueueStateError("Unsafe primary job directory");
    try { await mkdir(jobRoot, { mode: 0o700 }); await syncDirectory(root); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const rootInfo = await lstat(jobRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(jobRoot) !== jobRoot) throw new QueueStateError("Unsafe primary job directory");
    const queued = { ...job, queue: { version: 1, attempts: 0 } };
    try { await durableWriteJson(jobPath, queued); }
    catch (error) {
      let recovered;
      try { recovered = await readNoFollowJson(jobPath); } catch { throw error; }
      if (JSON.stringify(recovered) !== JSON.stringify(queued)) throw error;
    }
    try { await unlink(reservationPath); await syncDirectory(path.dirname(reservationPath)); }
    catch { /* Published job is authoritative; reservation counting deduplicates it. */ }
    return queued;
  } finally { await release(); }
}

async function cancelReservationWhileLocked(root, reservation) {
  const target = path.join(root, RESERVATIONS, `${reservation.id}.json`);
  let current;
  try { current = await readNoFollowJson(target); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
  if (current.tokenHash !== tokenHash(reservation.token)) return false;
  await unlink(target);
  await syncDirectory(path.dirname(target));
  return true;
}

export async function abortAdmissionStaging(jobsRoot, reservation) {
  if (!reservation || !UUID.test(reservation.id || "") || typeof reservation.token !== "string") return { published: false, cleaned: false };
  const release = await acquireQueueLock(jobsRoot);
  try {
    const root = await ensureJobsRoot(jobsRoot);
    const jobRoot = path.join(root, reservation.id);
    try {
      const existing = await readNoFollowJson(path.join(jobRoot, "job.json"));
      validateJobIdentity(existing, reservation.id);
      if (existing.queue?.version !== 1) throw new QueueStateError("Published primary job is not queue managed");
      await cancelReservationWhileLocked(root, reservation);
      return { published: true, cleaned: true, job: existing };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!await cancelReservationWhileLocked(root, reservation)) return { published: false, cleaned: false };
    try {
      const info = await lstat(jobRoot);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(jobRoot) !== jobRoot) throw new QueueStateError("Unsafe primary job staging directory");
      await rm(jobRoot, { recursive: true, force: true });
      await syncDirectory(root);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    return { published: false, cleaned: true };
  } finally { await release(); }
}

export async function publishQueuedJob(jobsRoot, job, maxActiveJobs) {
  const reservation = await reserveAdmission(jobsRoot, maxActiveJobs, job?.id);
  try {
    return await publishReservedQueuedJob(jobsRoot, job, reservation);
  } catch (error) { await cancelAdmission(jobsRoot, reservation).catch(() => {}); throw error; }
}

function leaseIsLive(job, now) {
  const lease = job.queue?.lease;
  return lease && typeof lease.tokenHash === "string" && Date.parse(lease.expiresAt) > now;
}
function queueAttempts(job) { return job.queue?.attempts ?? 0; }
function legacyIsQuiescent(job, now, quiescenceMs) {
  const activity = Date.parse(job.activityAt || job.updatedAt);
  return Number.isFinite(activity) && now - activity >= quiescenceMs;
}

export async function claimNextJob({ jobsRoot, workerId, leaseMs, maxAttempts, legacyQuiescenceMs = 300_000, now = Date.now() }) {
  if (typeof workerId !== "string" || !workerId || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1
      || !Number.isSafeInteger(legacyQuiescenceMs) || legacyQuiescenceMs < 0) throw new Error("Invalid primary worker claim configuration");
  const release = await acquireQueueLock(jobsRoot);
  try {
    const entries = (await listJobs(jobsRoot)).filter(({ job }) => ACTIVE.has(job.status))
      .sort((a, b) => (Date.parse(a.job.createdAt) || 0) - (Date.parse(b.job.createdAt) || 0));
    for (const entry of entries) {
      if (entry.job.queue === undefined && !legacyIsQuiescent(entry.job, now, legacyQuiescenceMs)) continue;
      if (leaseIsLive(entry.job, now)) continue;
      const attempts = queueAttempts(entry.job);
      if (attempts >= maxAttempts) {
        await durableWriteJson(entry.jobPath, { ...entry.job, status: "failed", progress: 100, stage: "failed", stageDetail: "Proses berhenti setelah batas percobaan tercapai", error: "Primary worker maximum attempts exceeded", updatedAt: new Date(now).toISOString(), queue: { version: 1, attempts } });
        continue;
      }
      const token = crypto.randomUUID();
      const claimedAt = new Date(now).toISOString();
      const claimed = { ...entry.job, status: "preparing", error: null, updatedAt: claimedAt, queue: { version: 1, attempts: attempts + 1, lease: { tokenHash: tokenHash(token), owner: workerId, claimedAt, heartbeatAt: claimedAt, expiresAt: new Date(now + leaseMs).toISOString() } } };
      await durableWriteJson(entry.jobPath, claimed);
      return { job: claimed, token };
    }
    return null;
  } finally { await release(); }
}

export async function fencedUpdateJob({ jobsRoot, id, token, patch, leaseMs, now = Date.now() }) {
  if (!UUID.test(id || "") || typeof token !== "string") throw new LeaseLostError();
  const release = await acquireQueueLock(jobsRoot);
  try {
    const jobPath = path.join(path.resolve(jobsRoot), id, "job.json");
    const current = await readNoFollowJson(jobPath);
    validateJobIdentity(current, id);
    if (current.queue?.version !== 1 || !current.queue.lease || current.queue.lease.tokenHash !== tokenHash(token)) throw new LeaseLostError();
    const terminal = TERMINAL.has(patch.status);
    const queue = terminal ? { version: 1, attempts: queueAttempts(current) } : { ...current.queue, lease: { ...current.queue.lease, heartbeatAt: new Date(now).toISOString(), expiresAt: new Date(now + leaseMs).toISOString() } };
    const next = { ...current, ...patch, queue, updatedAt: new Date(now).toISOString() };
    await durableWriteJson(jobPath, next);
    return next;
  } finally { await release(); }
}

export async function withFencedLease({ jobsRoot, id, token }, callback) {
  const release = await acquireQueueLock(jobsRoot);
  try {
    const current = await readNoFollowJson(path.join(path.resolve(jobsRoot), id, "job.json"));
    validateJobIdentity(current, id);
    if (current.queue?.version !== 1 || current.queue.lease?.tokenHash !== tokenHash(token)) throw new LeaseLostError();
    return await callback(current);
  } finally { await release(); }
}

export async function publishAttemptAndComplete({ jobsRoot, id, token, attemptOutput, patch, now = Date.now() }) {
  if (!UUID.test(id || "") || typeof token !== "string" || patch?.status !== "completed") {
    throw new QueueStateError("Attempt publication requires a valid completed claim");
  }
  const release = await acquireQueueLock(jobsRoot);
  try {
    const root = await ensureJobsRoot(jobsRoot);
    const jobRoot = path.join(root, id);
    const current = await readNoFollowJson(path.join(jobRoot, "job.json"));
    validateJobIdentity(current, id);
    const ownerHash = tokenHash(token);
    if (current.queue?.version !== 1 || current.queue.lease?.tokenHash !== ownerHash) throw new LeaseLostError();

    const attemptsRoot = path.join(jobRoot, ".attempts");
    const staged = path.resolve(attemptOutput);
    if (!contained(attemptsRoot, staged) || path.basename(staged) !== "output") throw new QueueStateError("Unsafe attempt output path");
    const stagedInfo = await lstat(staged);
    if (stagedInfo.isSymbolicLink() || !stagedInfo.isDirectory() || await realpath(staged) !== staged) throw new QueueStateError("Unsafe attempt output directory");
    await durableWriteJson(path.join(staged, ".attempt-owner.json"), { version: 1, id, tokenHash: ownerHash });
    await syncDirectory(staged);

    const output = path.join(jobRoot, "output");
    let alreadyPublished = false;
    try {
      const outputInfo = await lstat(output);
      if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory() || await realpath(output) !== output) throw new QueueStateError("Unsafe published output directory");
      const marker = await readNoFollowJson(path.join(output, ".attempt-owner.json"));
      alreadyPublished = marker.version === 1 && marker.id === id && marker.tokenHash === ownerHash;
      if (!alreadyPublished) {
        const orphan = path.join(attemptsRoot, `orphan.${crypto.randomUUID()}`);
        await rename(output, orphan);
        await syncDirectory(attemptsRoot);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!alreadyPublished) {
      await rename(staged, output);
      await syncDirectory(jobRoot);
    }

    const next = { ...current, ...patch, queue: { version: 1, attempts: queueAttempts(current) }, updatedAt: new Date(now).toISOString() };
    await durableWriteJson(path.join(jobRoot, "job.json"), next);
    return next;
  } finally { await release(); }
}

export async function validateClaimForExecution({ jobsRoot, claim }) {
  const root = await ensureJobsRoot(jobsRoot);
  const id = claim?.job?.id;
  if (!UUID.test(id || "")) throw new QueueStateError("Invalid primary claim job ID");
  const jobRoot = path.join(root, id);
  if (await realpath(jobRoot) !== jobRoot) throw new QueueStateError("Unsafe primary job path");
  const current = await readNoFollowJson(path.join(jobRoot, "job.json"));
  validateJobIdentity(current, id);
  if (current.queue?.lease?.tokenHash !== tokenHash(claim.token || "")) throw new LeaseLostError();
  if (current.source?.type === "upload") {
    if (typeof current.sourcePath !== "string") throw new QueueStateError("Invalid uploaded source path");
    const source = path.resolve(current.sourcePath);
    const inputRoot = path.join(jobRoot, "input");
    if (!contained(inputRoot, source)) throw new QueueStateError("Uploaded source escapes job input");
    const info = await lstat(source);
    if (info.isSymbolicLink() || !info.isFile() || await realpath(source) !== source) throw new QueueStateError("Unsafe uploaded source");
  }
  return { root, jobRoot, job: current };
}

export async function failClaimedJob({ jobsRoot, id, token, leaseMs, error, now = Date.now() }) {
  return fencedUpdateJob({ jobsRoot, id, token, leaseMs, now, patch: { status: "failed", progress: 100, stage: "failed", stageDetail: "Primary worker gagal memulai proses", error: error || "Primary worker spawn failed" } });
}
