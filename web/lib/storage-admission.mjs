import fs from "node:fs";
import path from "node:path";

const UINT64_MAX = (1n << 64n) - 1n;
const MAX_SCAN_ENTRIES = 10_000_000;
const MAX_SCAN_DEPTH = 1024;
const MAX_SCAN_DEADLINE_MS = 300_000;
const MAX_RECHECK_INTERVAL_MS = 300_000;

export class StorageAdmissionError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "StorageAdmissionError";
    this.code = code;
    this.status = code === "storage_admission_unavailable" ? 503 : 507;
  }
}

function unavailable(message, cause) {
  return new StorageAdmissionError("storage_admission_unavailable", message, cause === undefined ? {} : { cause });
}

function unescapeMountInfoPath(value) {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "\\") {
      result += value[index];
      continue;
    }
    const escape = value.slice(index, index + 4);
    const decoded = { "\\011": "\t", "\\012": "\n", "\\040": " ", "\\134": "\\" }[escape];
    if (decoded === undefined) throw unavailable("Mount metadata contains an invalid path escape");
    result += decoded;
    index += 3;
  }
  return result;
}

export function parseLinuxMountInfo(content) {
  if (typeof content !== "string" || content.length === 0) {
    throw unavailable("Mount metadata is unavailable");
  }
  const records = [];
  const mountIds = new Set();
  for (const line of content.endsWith("\n") ? content.slice(0, -1).split("\n") : content.split("\n")) {
    const fields = line.split(" ");
    const separator = fields.indexOf("-");
    if (fields.some((field) => field.length === 0) || separator < 6 || fields.length - separator < 4
      || !/^[1-9][0-9]*$/.test(fields[0]) || !/^(0|[1-9][0-9]*)$/.test(fields[1])
      || !/^(0|[1-9][0-9]*):(0|[1-9][0-9]*)$/.test(fields[2])) {
      throw unavailable("Mount metadata is malformed");
    }
    unescapeMountInfoPath(fields[3]);
    const mountpoint = unescapeMountInfoPath(fields[4]);
    if (!path.posix.isAbsolute(mountpoint)
      || path.posix.normalize(mountpoint) !== mountpoint
      || mountIds.has(fields[0])) {
      throw unavailable("Mount metadata is malformed");
    }
    mountIds.add(fields[0]);
    records.push({ mountId: fields[0], parentId: fields[1], mountpoint });
  }
  if (records.length === 0) throw unavailable("Mount metadata is unavailable");
  const visibleRecords = [];
  for (const mountpoint of new Set(records.map((record) => record.mountpoint))) {
    const stacked = records.filter((record) => record.mountpoint === mountpoint);
    const shadowedIds = new Set(stacked.map((record) => record.parentId));
    const visible = stacked.filter((record) => !shadowedIds.has(record.mountId));
    if (visible.length !== 1) throw unavailable("Mount metadata is ambiguous");
    visibleRecords.push(visible[0]);
  }
  visibleRecords.sort((left, right) => right.mountpoint.length - left.mountpoint.length);
  return {
    mountIdForPath(candidatePath) {
      if (typeof candidatePath !== "string" || !path.posix.isAbsolute(candidatePath)) return undefined;
      const normalized = path.posix.normalize(candidatePath);
      return visibleRecords.find(({ mountpoint }) => normalized === mountpoint
        || mountpoint === "/"
        || normalized.startsWith(`${mountpoint}/`))?.mountId;
    },
  };
}

function parseDecimalBigInt(env, name, { allowZero }) {
  const value = env[name];
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw unavailable(`${name} must be a strict decimal integer`);
  }
  const parsed = BigInt(value);
  if ((!allowZero && parsed === 0n) || parsed > UINT64_MAX) {
    throw unavailable(`${name} is outside the supported range`);
  }
  return parsed;
}

function parseBoundedInteger(env, name, { min = 1, max, defaultValue }) {
  const value = env[name];
  if (value === undefined && defaultValue !== undefined) return defaultValue;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) {
    throw unavailable(`${name} must be a positive decimal integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw unavailable(`${name} is outside the supported range`);
  }
  return parsed;
}

export function parseStorageAdmissionConfig(env = process.env) {
  return {
    quotaBytes: parseDecimalBigInt(env, "JOBS_STORAGE_QUOTA_BYTES", { allowZero: false }),
    minimumFreeBytes: parseDecimalBigInt(env, "JOBS_STORAGE_MIN_FREE_BYTES", { allowZero: true }),
    activeReserveBytes: parseDecimalBigInt(env, "JOBS_STORAGE_ACTIVE_RESERVE_BYTES", { allowZero: false }),
    scanMaxEntries: parseBoundedInteger(env, "JOBS_STORAGE_SCAN_MAX_ENTRIES", { max: MAX_SCAN_ENTRIES }),
    scanMaxDepth: parseBoundedInteger(env, "JOBS_STORAGE_SCAN_MAX_DEPTH", { max: MAX_SCAN_DEPTH }),
    scanDeadlineMs: parseBoundedInteger(env, "JOBS_STORAGE_SCAN_DEADLINE_MS", {
      max: MAX_SCAN_DEADLINE_MS,
      defaultValue: 30_000,
    }),
    recheckBytes: parseBoundedInteger(env, "JOBS_STORAGE_RECHECK_BYTES", {
      min: 8 * 1024 * 1024,
      max: 16 * 1024 * 1024,
      defaultValue: 8 * 1024 * 1024,
    }),
    recheckIntervalMs: parseBoundedInteger(env, "JOBS_STORAGE_RECHECK_INTERVAL_MS", {
      max: MAX_RECHECK_INTERVAL_MS,
      defaultValue: 5_000,
    }),
  };
}

function requireByteValue(value, name) {
  if (typeof value !== "bigint" || value < 0n || value > UINT64_MAX) {
    throw unavailable(`${name} must be a non-negative bigint`);
  }
  return value;
}

export function evaluateStorageAdmission({
  allocatedBytes,
  activeJobCount,
  activeReserveBytes,
  reservedBytes,
  contentLengthBytes,
  quotaBytes,
  availableBytes,
  minimumFreeBytes,
  newWorkReserveBytes = activeReserveBytes,
}) {
  const allocated = requireByteValue(allocatedBytes, "allocatedBytes");
  const reserve = requireByteValue(activeReserveBytes, "activeReserveBytes");
  const reserved = requireByteValue(reservedBytes, "reservedBytes");
  const contentLength = requireByteValue(contentLengthBytes, "contentLengthBytes");
  const quota = requireByteValue(quotaBytes, "quotaBytes");
  const available = requireByteValue(availableBytes, "availableBytes");
  const minimumFree = requireByteValue(minimumFreeBytes, "minimumFreeBytes");
  const newWorkReserve = requireByteValue(newWorkReserveBytes, "newWorkReserveBytes");
  if (!Number.isSafeInteger(activeJobCount) || activeJobCount < 0) {
    throw unavailable("activeJobCount must be a non-negative safe integer");
  }

  const activeGrowth = BigInt(activeJobCount) * reserve;
  const anticipatedWriteBytes = activeGrowth + reserved + contentLength + newWorkReserve;
  const projectedBytes = allocated + anticipatedWriteBytes;
  if (projectedBytes > quota) {
    throw new StorageAdmissionError("storage_quota_exhausted", "Storage quota exhausted");
  }
  if (anticipatedWriteBytes > available || available - anticipatedWriteBytes < minimumFree) {
    throw new StorageAdmissionError("storage_free_space_low", "Storage free space is below the required watermark");
  }
  return {
    allowed: true,
    projectedBytes,
    anticipatedWriteBytes,
    availableAfterWritesBytes: available - anticipatedWriteBytes,
  };
}

export async function readAvailableBytes(jobsRoot, { statfs = fs.promises.statfs } = {}) {
  try {
    if (typeof statfs !== "function") throw new TypeError("statfs unavailable");
    const result = await statfs(jobsRoot, { bigint: true });
    if (typeof result?.bavail !== "bigint" || typeof result?.bsize !== "bigint"
      || result.bavail < 0n || result.bsize <= 0n) {
      throw new TypeError("invalid statfs result");
    }
    return result.bavail * result.bsize;
  } catch (error) {
    if (error instanceof StorageAdmissionError) throw error;
    throw unavailable("Storage availability check failed", error);
  }
}

const FILE_TYPE_MASK = 0o170000n;
const REGULAR_FILE_TYPE = 0o100000n;
const DIRECTORY_TYPE = 0o040000n;
const OPEN_DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | fs.constants.O_DIRECTORY
  | fs.constants.O_NOFOLLOW
  | fs.constants.O_NONBLOCK;
const OPEN_FILE_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;

function sameObject(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && (left.mode & FILE_TYPE_MASK) === (right.mode & FILE_TYPE_MASK);
}

function inodeKey(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function checkScanArguments({ jobsRoot, maxEntries, maxDepth, deadlineMs }) {
  if (process.platform !== "linux" || typeof jobsRoot !== "string" || jobsRoot.length === 0) {
    throw unavailable("Safe storage scan is unavailable");
  }
  for (const [name, value, maximum] of [
    ["maxEntries", maxEntries, MAX_SCAN_ENTRIES],
    ["maxDepth", maxDepth, MAX_SCAN_DEPTH],
    ["deadlineMs", deadlineMs, MAX_SCAN_DEADLINE_MS],
  ]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw unavailable(`${name} is outside the supported range`);
    }
  }
}

async function openDirectoryPathNoFollow(directoryPath, ops, openedHandles) {
  const absolutePath = path.resolve(directoryPath);
  let currentHandle = await ops.open("/", OPEN_DIRECTORY_FLAGS);
  openedHandles.add(currentHandle);
  let currentStat = await currentHandle.stat({ bigint: true });
  for (const component of absolutePath.split(path.sep).filter(Boolean)) {
    const anchoredPath = `/proc/self/fd/${currentHandle.fd}/${component}`;
    const before = await ops.lstat(anchoredPath, { bigint: true });
    if ((before.mode & FILE_TYPE_MASK) !== DIRECTORY_TYPE) {
      throw unavailable("Jobs root path contains an unsafe component");
    }
    const nextHandle = await ops.open(anchoredPath, OPEN_DIRECTORY_FLAGS);
    openedHandles.add(nextHandle);
    const after = await nextHandle.stat({ bigint: true });
    if (!sameObject(before, after) || (after.mode & FILE_TYPE_MASK) !== DIRECTORY_TYPE) {
      throw unavailable("Jobs root path changed while opening");
    }
    currentHandle = nextHandle;
    currentStat = after;
  }
  return { absolutePath, handle: currentHandle, stat: currentStat };
}

export async function scanJobsStorage({
  jobsRoot,
  maxEntries,
  maxDepth,
  deadlineMs,
  now = Date.now,
  ops = fs.promises,
  readMountInfo = () => ops.readFile("/proc/self/mountinfo", "utf8"),
  hooks = {},
}) {
  checkScanArguments({ jobsRoot, maxEntries, maxDepth, deadlineMs });
  const deadline = now() + deadlineMs;
  const ensureWithinDeadline = () => {
    if (now() >= deadline) throw unavailable("Storage scan deadline exceeded");
  };
  const transform = async (hookName, details, fallback) => {
    if (typeof hooks[hookName] !== "function") return fallback;
    return (await hooks[hookName](details)) ?? fallback;
  };

  let rootHandle;
  let absoluteRoot;
  const directoryHandles = new Set();
  try {
    ensureWithinDeadline();
    const openedRoot = await openDirectoryPathNoFollow(jobsRoot, ops, directoryHandles);
    absoluteRoot = openedRoot.absolutePath;
    rootHandle = openedRoot.handle;
    let rootStat = openedRoot.stat;
    await hooks.afterOpenRoot?.({ jobsRoot: absoluteRoot, rootHandle, stat: rootStat });

    const initialMounts = parseLinuxMountInfo(await readMountInfo());
    const rootMountId = initialMounts.mountIdForPath(absoluteRoot);
    if (rootMountId === undefined) throw unavailable("Jobs root mount identity is unavailable");
    const scannedPaths = new Set([absoluteRoot]);
    const verifyInitialMountIdentity = (candidatePath) => {
      scannedPaths.add(candidatePath);
      if (initialMounts.mountIdForPath(candidatePath) !== rootMountId) {
        throw unavailable("Storage tree crosses a mount boundary");
      }
    };

    const rootDevice = rootStat.dev;
    const seenDirectories = new Set([inodeKey(rootStat)]);
    let allocatedBytes = 0n;
    let entryCount = 0;
    let fileCount = 0;
    let directoryCount = 0;

    const scanDirectory = async (currentHandle, depth, relativeComponents) => {
      ensureWithinDeadline();
      const descriptorPath = `/proc/self/fd/${currentHandle.fd}`;
      const directory = await ops.opendir(descriptorPath);
      try {
        for await (const entry of directory) {
          ensureWithinDeadline();
          entryCount += 1;
          if (entryCount > maxEntries) throw unavailable("Storage scan entry bound exceeded");
          const childDepth = depth + 1;
          if (childDepth > maxDepth) throw unavailable("Storage scan depth bound exceeded");
          if (entry.name === "." || entry.name === ".." || entry.name.includes("/")) {
            throw unavailable("Storage tree contains an unsafe entry name");
          }
          const anchoredPath = `${descriptorPath}/${entry.name}`;
          const logicalPath = path.join(absoluteRoot, ...relativeComponents, entry.name);
          verifyInitialMountIdentity(logicalPath);
          let before = await ops.lstat(anchoredPath, { bigint: true });
          before = await transform("afterLstat", {
            stat: before,
            name: entry.name,
            depth: childDepth,
            anchoredPath,
          }, before);
          await hooks.beforeOpenEntry?.({
            stat: before,
            name: entry.name,
            depth: childDepth,
            anchoredPath,
          });
          const type = before.mode & FILE_TYPE_MASK;
          if (before.dev !== rootDevice) throw unavailable("Storage tree crosses a mount boundary");

          if (type === REGULAR_FILE_TYPE) {
            const fileHandle = await ops.open(anchoredPath, OPEN_FILE_FLAGS);
            try {
              let after = await fileHandle.stat({ bigint: true });
              after = await transform("afterFstat", {
                stat: after,
                name: entry.name,
                depth: childDepth,
                anchoredPath,
              }, after);
              if (!sameObject(before, after) || (after.mode & FILE_TYPE_MASK) !== REGULAR_FILE_TYPE) {
                throw unavailable("Storage object changed during scan");
              }
              allocatedBytes += after.blocks * 512n;
              fileCount += 1;
            } finally {
              await fileHandle.close();
            }
          } else if (type === DIRECTORY_TYPE) {
            const childHandle = await ops.open(anchoredPath, OPEN_DIRECTORY_FLAGS);
            directoryHandles.add(childHandle);
            try {
              let after = await childHandle.stat({ bigint: true });
              after = await transform("afterFstat", {
                stat: after,
                name: entry.name,
                depth: childDepth,
                anchoredPath,
              }, after);
              if (!sameObject(before, after) || (after.mode & FILE_TYPE_MASK) !== DIRECTORY_TYPE) {
                throw unavailable("Storage directory changed during scan");
              }
              if (after.dev !== rootDevice) throw unavailable("Storage tree crosses a mount boundary");
              const key = inodeKey(after);
              if (seenDirectories.has(key)) throw unavailable("Storage tree repeats a directory inode");
              seenDirectories.add(key);
              allocatedBytes += after.blocks * 512n;
              directoryCount += 1;
              await scanDirectory(childHandle, childDepth, [...relativeComponents, entry.name]);
              const finalChild = await ops.lstat(anchoredPath, { bigint: true });
              const finalChildFd = await childHandle.stat({ bigint: true });
              if (!sameObject(finalChild, finalChildFd)) {
                throw unavailable("Storage directory changed during scan");
              }
            } finally {
              directoryHandles.delete(childHandle);
              await childHandle.close();
            }
          } else {
            throw unavailable("Storage tree contains an unsafe object type");
          }
        }
      } finally {
        try {
          await directory.close();
        } catch (error) {
          if (error?.code !== "ERR_DIR_CLOSED") throw error;
        }
      }
    };

    await scanDirectory(rootHandle, 0, []);

    ensureWithinDeadline();
    const finalMounts = parseLinuxMountInfo(await readMountInfo());
    if ([...scannedPaths].some((candidatePath) => finalMounts.mountIdForPath(candidatePath) !== rootMountId)) {
      throw unavailable("Storage tree crosses a mount boundary");
    }
    const finalRoot = await ops.lstat(absoluteRoot, { bigint: true });
    const finalRootFd = await rootHandle.stat({ bigint: true });
    if (!sameObject(finalRoot, finalRootFd)) throw unavailable("Jobs root changed during scan");
    return { allocatedBytes, entryCount, fileCount, directoryCount };
  } catch (error) {
    if (error instanceof StorageAdmissionError) throw error;
    throw unavailable("Safe storage scan failed", error);
  } finally {
    for (const handle of directoryHandles) {
      try {
        await handle.close();
      } catch {
        // Closing is best effort; the primary scan error remains authoritative.
      }
    }
  }
}
