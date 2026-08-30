import crypto from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

import { durableWriteJson, withPrimaryQueueLock } from "./primary-job-queue.mjs";
import { readSharedStorageAccounting } from "./shared-storage-accounting.mjs";
import {
  evaluateStorageAdmission,
  readAvailableBytes,
  scanJobsStorage,
  StorageAdmissionError,
} from "./storage-admission.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const DIRECTORY = ".render-reservations";
const PRIMARY_DIRECTORY = ".primary-reservations";
const MAX_UINT64 = (1n << 64n) - 1n;
const ADMISSION_TTL_MS = 60 * 60_000;
const KEYS = [
  "createdAt", "declaredBytes", "expiresAt", "heartbeatAt", "jobId", "renderId",
  "reservationId", "state", "tokenHash", "version", "workReserveBytes",
].sort();

function unavailable(message, cause) {
  return new StorageAdmissionError("storage_admission_unavailable", message, cause ? { cause } : {});
}
function bytes(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw unavailable("Render storage reservation is malformed");
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) throw unavailable("Render storage reservation is malformed");
  return parsed;
}
function tokenHash(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function validate(value, id) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(KEYS)
      || value.version !== 1 || value.reservationId !== id || !UUID.test(id)
      || !UUID.test(value.jobId || "") || !SHA.test(value.tokenHash || "")
      || !["admitting", "queued", "active"].includes(value.state)
      || (value.renderId !== null && !UUID.test(value.renderId))
      || !Number.isFinite(Date.parse(value.createdAt))
      || !Number.isFinite(Date.parse(value.heartbeatAt))
      || !Number.isFinite(Date.parse(value.expiresAt))) {
    throw unavailable("Render storage reservation is malformed");
  }
  return { value, declared: bytes(value.declaredBytes), work: bytes(value.workReserveBytes) };
}
async function readJsonNoFollow(target, maximum = 64 * 1024) {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) throw unavailable("Storage reservation is unsafe");
    return JSON.parse(await handle.readFile("utf8"));
  } finally { await handle.close(); }
}

async function terminalRequestOwnsReservation(root, item) {
  if (item.value.renderId === null) return false;
  const job = path.join(root, item.value.jobId);
  const analysis = path.join(job, "analysis");
  const requests = path.join(analysis, "render-requests");
  try {
    for (const directory of [job, analysis, requests]) {
      const info = await lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) {
        throw unavailable("Render request directory is unsafe");
      }
    }
    const request = await readJsonNoFollow(
      path.join(requests, `${item.value.renderId}.json`),
      2 * 1024 * 1024,
    );
    return request?.version === "render-request-v2"
      && request.render_id === item.value.renderId
      && ["completed", "failed"].includes(request.state)
      && request.storage_reservation_id === item.value.reservationId
      && typeof request.storage_reservation_token === "string"
      && tokenHash(request.storage_reservation_token) === item.value.tokenHash;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function renderReservations(root, now) {
  const directory = path.join(root, DIRECTORY);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) throw unavailable("Render storage reservation is unsafe");
    const id = entry.name.slice(0, -5);
    const target = path.join(directory, entry.name);
    const item = validate(await readJsonNoFollow(target), id);
    if ((item.value.state === "admitting" && Date.parse(item.value.expiresAt) <= now)
        || await terminalRequestOwnsReservation(root, item)) {
      await unlink(target);
    } else result.push(item);
  }
  await syncDirectory(directory);
  return { directory, result };
}
async function primaryReservedBytes(root) {
  const directory = path.join(root, PRIMARY_DIRECTORY);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return 0n; throw error; }
  let total = 0n;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith(".json")) throw unavailable("Primary storage reservation is unsafe");
    const value = await readJsonNoFollow(path.join(directory, entry.name));
    if (value.version !== 2) throw unavailable("Primary storage reservation is unsupported");
    total += bytes(value.remainingRequestBytes) + bytes(value.workReserveBytes);
  }
  return total;
}
async function snapshot(root, config, storageOps) {
  const scan = storageOps?.scan || ((options) => scanJobsStorage(options));
  const available = storageOps?.available || ((target) => readAvailableBytes(target));
  const [{ allocatedBytes }, availableBytes] = await Promise.all([
    scan({ jobsRoot: root, maxEntries: config.scanMaxEntries, maxDepth: config.scanMaxDepth, deadlineMs: config.scanDeadlineMs }),
    available(root),
  ]);
  return { allocatedBytes, availableBytes };
}
function evaluateSnapshot(storageSnapshot, config, accounting, contentLength, newWork) {
  return evaluateStorageAdmission({
    ...storageSnapshot, activeJobCount: accounting.activePrimaryCount,
    activeReserveBytes: config.activeReserveBytes, reservedBytes: accounting.reservedBytes,
    contentLengthBytes: contentLength, quotaBytes: config.quotaBytes,
    minimumFreeBytes: config.minimumFreeBytes, newWorkReserveBytes: newWork,
  });
}

export async function reserveRenderStorage(jobsRoot, options) {
  const { reservationId, jobId, declaredBytes, storageConfig, storageOps } = options || {};
  const now = options?.now ?? Date.now();
  if (!UUID.test(reservationId || "") || !UUID.test(jobId || "") || typeof declaredBytes !== "bigint"
      || declaredBytes < 0n || declaredBytes > MAX_UINT64 || !storageConfig) throw unavailable("Render storage admission request is invalid");
  const storageSnapshot = await snapshot(path.resolve(jobsRoot), storageConfig, storageOps);
  return withPrimaryQueueLock(jobsRoot, async () => {
    const root = path.resolve(jobsRoot);
    const { directory, result } = await renderReservations(root, now);
    if (result.some((item) => item.value.reservationId === reservationId)) throw unavailable("Render storage reservation already exists");
    const accounting = await readSharedStorageAccounting(root, (message) => unavailable(message));
    evaluateSnapshot(storageSnapshot, storageConfig, accounting, declaredBytes, storageConfig.activeReserveBytes);
    const token = crypto.randomUUID();
    const timestamp = new Date(now).toISOString();
    const reservedBytes = declaredBytes + storageConfig.activeReserveBytes;
    await durableWriteJson(path.join(directory, `${reservationId}.json`), {
      version: 1, reservationId, jobId, renderId: null, state: "admitting",
      tokenHash: tokenHash(token), declaredBytes: declaredBytes.toString(),
      workReserveBytes: storageConfig.activeReserveBytes.toString(), createdAt: timestamp,
      heartbeatAt: timestamp, expiresAt: new Date(now + ADMISSION_TTL_MS).toISOString(),
    });
    return { reservationId, token, reservedBytes: reservedBytes.toString() };
  });
}

export async function bindRenderStorage(jobsRoot, reservationId, token, renderId) {
  if (!UUID.test(reservationId || "") || !UUID.test(renderId || "") || typeof token !== "string") return false;
  return withPrimaryQueueLock(jobsRoot, async () => {
    const target = path.join(path.resolve(jobsRoot), DIRECTORY, `${reservationId}.json`);
    let item;
    try { item = validate(await readJsonNoFollow(target), reservationId); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (item.value.tokenHash !== tokenHash(token)) return false;
    const now = new Date().toISOString();
    await durableWriteJson(target, { ...item.value, renderId, state: "queued", heartbeatAt: now, expiresAt: now });
    return true;
  });
}

export async function heartbeatRenderStorage(jobsRoot, reservationId, token, storageConfig, storageOps) {
  if (!UUID.test(reservationId || "") || typeof token !== "string" || !storageConfig) return false;
  const storageSnapshot = await snapshot(path.resolve(jobsRoot), storageConfig, storageOps);
  return withPrimaryQueueLock(jobsRoot, async () => {
    const root = path.resolve(jobsRoot);
    const { result } = await renderReservations(root, Date.now());
    const own = result.find((item) => item.value.reservationId === reservationId);
    if (!own || own.value.tokenHash !== tokenHash(token)) return false;
    const accounting = await readSharedStorageAccounting(root, (message) => unavailable(message));
    evaluateSnapshot(storageSnapshot, storageConfig, accounting, 0n, 0n);
    const now = new Date().toISOString();
    await durableWriteJson(path.join(root, DIRECTORY, `${reservationId}.json`), {
      ...own.value, state: own.value.renderId ? "active" : own.value.state,
      heartbeatAt: now, expiresAt: new Date(Date.now() + ADMISSION_TTL_MS).toISOString(),
    });
    return true;
  });
}

export async function releaseRenderStorage(jobsRoot, reservationId, token, terminalState) {
  if (!UUID.test(reservationId || "") || typeof token !== "string" || !["completed", "failed"].includes(terminalState)) return false;
  return withPrimaryQueueLock(jobsRoot, async () => {
    const directory = path.join(path.resolve(jobsRoot), DIRECTORY);
    const target = path.join(directory, `${reservationId}.json`);
    let item;
    try { item = validate(await readJsonNoFollow(target), reservationId); } catch (error) { if (error.code === "ENOENT") return false; throw error; }
    if (item.value.tokenHash !== tokenHash(token)) return false;
    await unlink(target);
    await syncDirectory(directory);
    return true;
  });
}
