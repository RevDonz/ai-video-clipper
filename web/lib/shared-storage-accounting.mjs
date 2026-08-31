import crypto from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
const ACTIVE = new Set(["queued", "preparing", "downloading", "processing"]);
const PRIMARY_KEYS = ["consumedRequestBytes", "createdAt", "declaredRequestBytes", "expiresAt", "id", "remainingRequestBytes", "tokenHash", "version", "workReserveBytes"].sort();
const RENDER_KEYS = ["createdAt", "declaredBytes", "expiresAt", "heartbeatAt", "jobId", "renderId", "reservationId", "state", "tokenHash", "version", "workReserveBytes"].sort();
const MAX_UINT64 = (1n << 64n) - 1n;

function fail(errorFactory, message) {
  throw errorFactory(message);
}
function bytes(value, errorFactory) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail(errorFactory, "Malformed shared storage reservation");
  const parsed = BigInt(value);
  if (parsed > MAX_UINT64) fail(errorFactory, "Malformed shared storage reservation");
  return parsed;
}
async function readJson(target, maximum, errorFactory) {
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maximum) fail(errorFactory, "Unsafe shared storage state");
    return JSON.parse(await handle.readFile("utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    if (error?.name && ["QueueStateError", "StorageAdmissionError"].includes(error.name)) throw error;
    fail(errorFactory, "Cannot inspect shared storage state");
  } finally { await handle?.close(); }
}
async function activePrimaryIds(root, errorFactory) {
  const ids = new Set();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!UUID.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) fail(errorFactory, "Unsafe primary job state");
    const jobRoot = path.join(root, entry.name);
    if (await realpath(jobRoot) !== jobRoot) fail(errorFactory, "Unsafe primary job state");
    let job;
    try { job = await readJson(path.join(jobRoot, "job.json"), 2 * 1024 * 1024, errorFactory); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!job || job.id !== entry.name || typeof job.status !== "string") fail(errorFactory, "Malformed primary job state");
    if (ACTIVE.has(job.status)) ids.add(entry.name);
  }
  return ids;
}
async function primaryReservations(root, activeIds, errorFactory) {
  const directory = path.join(root, ".primary-reservations");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return 0n; throw error; }
  let total = 0n;
  for (const entry of entries) {
    const id = entry.name.replace(/\.json$/, "");
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name !== `${id}.json` || !UUID.test(id)) fail(errorFactory, "Unsafe primary storage reservation");
    const value = await readJson(path.join(directory, entry.name), 64 * 1024, errorFactory);
    if (value?.version === 1) fail(errorFactory, "Live legacy primary storage reservation");
    if (!value || value.version !== 2 || value.id !== id || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(PRIMARY_KEYS)
        || !SHA.test(value.tokenHash || "") || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.expiresAt))) {
      fail(errorFactory, "Malformed primary storage reservation");
    }
    const declared = bytes(value.declaredRequestBytes, errorFactory);
    const consumed = bytes(value.consumedRequestBytes, errorFactory);
    const remaining = bytes(value.remainingRequestBytes, errorFactory);
    const work = bytes(value.workReserveBytes, errorFactory);
    if (consumed > declared || remaining !== declared - consumed || work === 0n) fail(errorFactory, "Malformed primary storage reservation");
    if (!activeIds.has(id) && Date.parse(value.expiresAt) > Date.now()) total += remaining + work;
  }
  return total;
}
async function terminalRenderOwns(root, item, errorFactory) {
  if (item.renderId === null) return false;
  const target = path.join(root, item.jobId, "analysis", "render-requests", `${item.renderId}.json`);
  let request;
  try { request = await readJson(target, 2 * 1024 * 1024, errorFactory); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
  return request?.version === "render-request-v2" && request.render_id === item.renderId
    && ["completed", "failed"].includes(request.state)
    && request.storage_reservation_id === item.reservationId
    && typeof request.storage_reservation_token === "string"
    && crypto.createHash("sha256").update(request.storage_reservation_token).digest("hex") === item.tokenHash;
}
async function renderReservations(root, errorFactory) {
  const directory = path.join(root, ".render-reservations");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return 0n; throw error; }
  let total = 0n;
  for (const entry of entries) {
    const id = entry.name.replace(/\.json$/, "");
    if (!entry.isFile() || entry.isSymbolicLink() || entry.name !== `${id}.json` || !UUID.test(id)) fail(errorFactory, "Unsafe render storage reservation");
    const value = await readJson(path.join(directory, entry.name), 64 * 1024, errorFactory);
    if (!value || value.version !== 1 || value.reservationId !== id || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(RENDER_KEYS)
        || !UUID.test(value.jobId || "") || !SHA.test(value.tokenHash || "") || !["admitting", "queued", "active"].includes(value.state)
        || (value.renderId !== null && !UUID.test(value.renderId)) || !Number.isFinite(Date.parse(value.createdAt))
        || !Number.isFinite(Date.parse(value.heartbeatAt)) || !Number.isFinite(Date.parse(value.expiresAt))) {
      fail(errorFactory, "Malformed render storage reservation");
    }
    const declared = bytes(value.declaredBytes, errorFactory);
    const work = bytes(value.workReserveBytes, errorFactory);
    const expiredUnbound = value.state === "admitting" && Date.parse(value.expiresAt) <= Date.now();
    if (!expiredUnbound && !await terminalRenderOwns(root, value, errorFactory)) total += declared + work;
  }
  return total;
}

export async function readSharedStorageAccounting(root, errorFactory = (message) => new Error(message)) {
  const resolved = path.resolve(root);
  const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(resolved) !== resolved) fail(errorFactory, "Unsafe jobs root");
  const activeIds = await activePrimaryIds(resolved, errorFactory);
  const [primaryReservedBytes, renderReservedBytes] = await Promise.all([
    primaryReservations(resolved, activeIds, errorFactory),
    renderReservations(resolved, errorFactory),
  ]);
  return {
    activePrimaryCount: activeIds.size,
    primaryReservedBytes,
    renderReservedBytes,
    reservedBytes: primaryReservedBytes + renderReservedBytes,
  };
}
