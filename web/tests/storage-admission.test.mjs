import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import {
  lstat,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  evaluateStorageAdmission,
  parseLinuxMountInfo,
  parseStorageAdmissionConfig,
  readAvailableBytes,
  scanJobsStorage,
  StorageAdmissionError,
} from "../lib/storage-admission.mjs";

const execFileAsync = promisify(execFile);

const mountInfoEscape = (value) => value.replaceAll("\\", "\\134")
  .replaceAll(" ", "\\040")
  .replaceAll("\t", "\\011")
  .replaceAll("\n", "\\012");

const validEnv = {
  JOBS_STORAGE_QUOTA_BYTES: "1000",
  JOBS_STORAGE_MIN_FREE_BYTES: "100",
  JOBS_STORAGE_ACTIVE_RESERVE_BYTES: "200",
  JOBS_STORAGE_SCAN_MAX_ENTRIES: "1000",
  JOBS_STORAGE_SCAN_MAX_DEPTH: "20",
};

test("parseStorageAdmissionConfig parses strict decimal values", () => {
  assert.deepEqual(parseStorageAdmissionConfig(validEnv), {
    quotaBytes: 1000n,
    minimumFreeBytes: 100n,
    activeReserveBytes: 200n,
    scanMaxEntries: 1000,
    scanMaxDepth: 20,
    scanDeadlineMs: 30_000,
    recheckIntervalMs: 5_000,
  });
});

test("parseStorageAdmissionConfig fails closed for invalid and overflowing values", () => {
  const invalidCases = [
    ["JOBS_STORAGE_QUOTA_BYTES", undefined],
    ["JOBS_STORAGE_QUOTA_BYTES", "0"],
    ["JOBS_STORAGE_QUOTA_BYTES", " 1"],
    ["JOBS_STORAGE_QUOTA_BYTES", "+1"],
    ["JOBS_STORAGE_QUOTA_BYTES", "01"],
    ["JOBS_STORAGE_QUOTA_BYTES", "-1"],
    ["JOBS_STORAGE_QUOTA_BYTES", "18446744073709551616"],
    ["JOBS_STORAGE_MIN_FREE_BYTES", "-1"],
    ["JOBS_STORAGE_ACTIVE_RESERVE_BYTES", "0"],
    ["JOBS_STORAGE_SCAN_MAX_ENTRIES", "0"],
    ["JOBS_STORAGE_SCAN_MAX_ENTRIES", "10000001"],
    ["JOBS_STORAGE_SCAN_MAX_DEPTH", "1025"],
    ["JOBS_STORAGE_SCAN_DEADLINE_MS", "300001"],
    ["JOBS_STORAGE_RECHECK_INTERVAL_MS", "1.5"],
  ];

  for (const [name, value] of invalidCases) {
    const env = { ...validEnv };
    if (value === undefined) delete env[name];
    else env[name] = value;
    assert.throws(
      () => parseStorageAdmissionConfig(env),
      (error) => error instanceof StorageAdmissionError
        && error.code === "storage_admission_unavailable"
        && error.status === 503,
      `${name}=${String(value)}`,
    );
  }
});

test("evaluateStorageAdmission permits exact quota and free-space boundaries", () => {
  const result = evaluateStorageAdmission({
    allocatedBytes: 100n,
    activeJobCount: 1,
    activeReserveBytes: 20n,
    reservedBytes: 30n,
    contentLengthBytes: 40n,
    quotaBytes: 210n,
    availableBytes: 210n,
    minimumFreeBytes: 100n,
  });
  assert.deepEqual(result, {
    allowed: true,
    projectedBytes: 210n,
    anticipatedWriteBytes: 110n,
    availableAfterWritesBytes: 100n,
  });
});

test("evaluateStorageAdmission uses fixed quota and free-space failures", () => {
  assert.throws(
    () => evaluateStorageAdmission({
      allocatedBytes: 101n,
      activeJobCount: 1,
      activeReserveBytes: 20n,
      reservedBytes: 30n,
      contentLengthBytes: 40n,
      quotaBytes: 210n,
      availableBytes: 1_000n,
      minimumFreeBytes: 100n,
    }),
    (error) => error.code === "storage_quota_exhausted" && error.status === 507,
  );
  assert.throws(
    () => evaluateStorageAdmission({
      allocatedBytes: 100n,
      activeJobCount: 1,
      activeReserveBytes: 20n,
      reservedBytes: 30n,
      contentLengthBytes: 40n,
      quotaBytes: 1_000n,
      availableBytes: 189n,
      minimumFreeBytes: 100n,
    }),
    (error) => error.code === "storage_free_space_low" && error.status === 507,
  );
});

test("readAvailableBytes uses bavail rather than bfree", async () => {
  let seenOptions;
  const available = await readAvailableBytes("/jobs", {
    statfs: async (_root, options) => {
      seenOptions = options;
      return { bavail: 7n, bfree: 99n, bsize: 4096n };
    },
  });
  assert.equal(available, 28_672n);
  assert.deepEqual(seenOptions, { bigint: true });
});

test("readAvailableBytes maps statfs failures and unsupported values to unavailable", async () => {
  await assert.rejects(
    readAvailableBytes("/jobs", { statfs: async () => { throw new Error("offline /secret"); } }),
    (error) => error.code === "storage_admission_unavailable"
      && error.status === 503
      && !error.message.includes("/secret"),
  );
  await assert.rejects(
    readAvailableBytes("/jobs", { statfs: async () => ({ bavail: 1, bsize: 2 }) }),
    (error) => error.code === "storage_admission_unavailable",
  );
});

test("parseLinuxMountInfo unescapes paths and uses path-component-aware longest mountpoints", () => {
  const mounts = parseLinuxMountInfo([
    "21 1 8:1 / /jobs rw - ext4 /dev/root rw",
    "22 21 8:1 /source\\040dir /jobs/archive\\040set rw - ext4 /dev/root rw",
    "23 21 8:1 /slash\\134root /jobs/archive\\040set/nested\\134name rw - ext4 /dev/root rw",
    "24 1 8:1 / /jobs-other rw - ext4 /dev/root rw",
  ].join("\n"));

  assert.equal(mounts.mountIdForPath("/jobs/file"), "21");
  assert.equal(mounts.mountIdForPath("/jobs/archive set/item"), "22");
  assert.equal(mounts.mountIdForPath("/jobs/archive set/nested\\name/item"), "23");
  assert.equal(mounts.mountIdForPath("/jobs-other/item"), "24");
  assert.equal(mounts.mountIdForPath("/jobs-otherish"), undefined);
});

test("parseLinuxMountInfo fails closed on malformed lines and path escapes", () => {
  for (const mountInfo of [
    "",
    "21 1 8:1 / /jobs rw ext4 /dev/root rw",
    "not-a-number 1 8:1 / /jobs rw - ext4 /dev/root rw",
    "21 1 not-a-device / /jobs rw - ext4 /dev/root rw",
    "21 1 8:1 / /jobs\\04 rw - ext4 /dev/root rw",
    "21 1 8:1 / /jobs\\041 rw - ext4 /dev/root rw",
    "21 1 8:1 / /jobs rw - ext4 /dev/root rw\nmalformed",
  ]) {
    assert.throws(() => parseLinuxMountInfo(mountInfo), StorageAdmissionError);
  }
});

test("scanJobsStorage counts every object without interpreting job metadata", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-scan-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = [
    ["old/job.json", "{\"status\":\"completed\"}"],
    ["failed/job.json", "{\"status\":\"failed\"}"],
    ["malformed/job.json", "not-json"],
    ["incomplete/input.bin", "partial"],
    [".hidden-attempt/work.bin", "hidden"],
  ];
  for (const [relative, content] of files) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
  }
  const fileAllocation = (await Promise.all(files.map(([relative]) => stat(path.join(root, relative), { bigint: true }))))
    .reduce((sum, item) => sum + item.blocks * 512n, 0n);

  const result = await scanJobsStorage({
    jobsRoot: root,
    maxEntries: 100,
    maxDepth: 10,
    deadlineMs: 10_000,
  });

  assert.equal(result.entryCount, 10);
  assert.equal(result.fileCount, 5);
  assert.equal(result.directoryCount, 5);
  assert.ok(result.allocatedBytes >= fileAllocation);
});

const scanDefaults = (jobsRoot, overrides = {}) => ({
  jobsRoot,
  maxEntries: 100,
  maxDepth: 10,
  deadlineMs: 10_000,
  ...overrides,
});

async function rejectsUnavailable(promise) {
  await assert.rejects(
    promise,
    (error) => error instanceof StorageAdmissionError
      && error.code === "storage_admission_unavailable"
      && error.status === 503,
  );
}

test("scanJobsStorage rejects root and nested symlinks", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "storage-symlink-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const realRoot = path.join(parent, "real");
  await mkdir(realRoot);
  const linkedRoot = path.join(parent, "linked");
  await symlink(realRoot, linkedRoot);
  await rejectsUnavailable(scanJobsStorage(scanDefaults(linkedRoot)));

  const realParent = path.join(parent, "real-parent");
  await mkdir(path.join(realParent, "jobs"), { recursive: true });
  const linkedParent = path.join(parent, "linked-parent");
  await symlink(realParent, linkedParent);
  await rejectsUnavailable(scanJobsStorage(scanDefaults(path.join(linkedParent, "jobs"))));

  await writeFile(path.join(realRoot, "target"), "data");
  await symlink("target", path.join(realRoot, "file-link"));
  await rejectsUnavailable(scanJobsStorage(scanDefaults(realRoot)));
  await rm(path.join(realRoot, "file-link"));

  await mkdir(path.join(realRoot, "directory"));
  await symlink("directory", path.join(realRoot, "directory-link"));
  await rejectsUnavailable(scanJobsStorage(scanDefaults(realRoot)));
});

test("scanJobsStorage rejects FIFOs and Unix sockets", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-special-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fifo = path.join(root, "pipe");
  await execFileAsync("mkfifo", [fifo]);
  await rejectsUnavailable(scanJobsStorage(scanDefaults(root)));
  await rm(fifo);

  const socketPath = path.join(root, "socket");
  const server = net.createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve, reject) => server.listen(socketPath, (error) => error ? reject(error) : resolve()));
  await rejectsUnavailable(scanJobsStorage(scanDefaults(root)));
});

test("scanJobsStorage rejects device types and mount crossings", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-fake-type-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "entry"), "data");

  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, {
    hooks: { afterLstat: ({ stat: item }) => ({ ...item, mode: (item.mode & ~0o170000n) | 0o020000n }) },
  })));
  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, {
    hooks: { afterLstat: ({ stat: item }) => ({ ...item, dev: item.dev + 1n }) },
  })));
});

test("scanJobsStorage rejects an injected same-device nested bind mount", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-bind-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "same device");
  await mkdir(nested);
  await writeFile(path.join(nested, "entry"), "data");
  const actualMountInfo = await readFile("/proc/self/mountinfo", "utf8");
  const rootMountId = parseLinuxMountInfo(actualMountInfo).mountIdForPath(root);
  const injectedMountId = rootMountId === "999999999" ? "999999998" : "999999999";
  const withBindMount = `${actualMountInfo.trimEnd()}\n${injectedMountId} ${rootMountId} 0:1 /source ${mountInfoEscape(nested)} rw - ext4 /dev/root rw\n`;

  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, {
    readMountInfo: async () => withBindMount,
  })));
});

test("scanJobsStorage rejects a real same-device bind mount in an isolated mount namespace", async (t) => {
  if (process.platform !== "linux") return t.skip("Linux mount namespaces are required");
  const parent = await mkdtemp(path.join(os.tmpdir(), "storage-real-bind-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, "source");
  const root = path.join(parent, "jobs");
  const nested = path.join(root, "nested");
  await mkdir(source);
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(source, "entry"), "data");
  const moduleUrl = new URL("../lib/storage-admission.mjs", import.meta.url).href;
  const childProgram = [
    "const { scanJobsStorage } = await import(process.argv[2]);",
    "try {",
    "  await scanJobsStorage({ jobsRoot: process.argv[1], maxEntries: 100, maxDepth: 10, deadlineMs: 10000 });",
    "  process.exit(42);",
    "} catch (error) {",
    "  if (error?.code !== 'storage_admission_unavailable') throw error;",
    "}",
  ].join("\n");
  const shell = "mount --bind \"$1\" \"$2\"\nnode --input-type=module -e \"$5\" \"$3\" \"$4\"";

  try {
    await execFileAsync("unshare", [
      "--user", "--map-root-user", "--mount", "sh", "-ceu", shell,
      "storage-bind-test", source, nested, root, moduleUrl, childProgram,
    ]);
  } catch (error) {
    const diagnostic = `${error?.stderr ?? ""}\n${error?.message ?? ""}`;
    if (/operation not permitted|permission denied|unshare failed/i.test(diagnostic)) {
      return t.skip("User/mount namespace capability is unavailable");
    }
    throw error;
  }
});

test("scanJobsStorage fails closed when mount metadata is unavailable, malformed, or changes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-mount-race-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nested = path.join(root, "nested\\name");
  await mkdir(nested);
  await writeFile(path.join(nested, "entry"), "data");

  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, {
    readMountInfo: async () => { throw new Error("mountinfo unavailable"); },
  })));
  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, {
    readMountInfo: async () => "malformed",
  })));

  const actualMountInfo = await readFile("/proc/self/mountinfo", "utf8");
  const rootMountId = parseLinuxMountInfo(actualMountInfo).mountIdForPath(root);
  const changedMountInfo = `${actualMountInfo.trimEnd()}\n999999999 ${rootMountId} 0:1 /source ${mountInfoEscape(nested)} rw - ext4 /dev/root rw\n`;
  let reads = 0;
  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, {
    readMountInfo: async () => reads++ === 0 ? actualMountInfo : changedMountInfo,
  })));
  assert.ok(reads >= 2);
});

test("scanJobsStorage detects inode swaps and jobs-root ancestor replacement", async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "storage-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "jobs");
  await mkdir(root);
  await writeFile(path.join(root, "entry"), "old");
  let swapped = false;
  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, {
    hooks: {
      beforeOpenEntry: async ({ anchoredPath }) => {
        if (swapped) return;
        swapped = true;
        await rename(anchoredPath, `${anchoredPath}.old`);
        await writeFile(anchoredPath, "replacement");
      },
    },
  })));

  const stableRoot = path.join(parent, "stable");
  const movedRoot = path.join(parent, "moved");
  await mkdir(stableRoot);
  await writeFile(path.join(stableRoot, "entry"), "data");
  await rejectsUnavailable(scanJobsStorage(scanDefaults(stableRoot, {
    hooks: {
      afterOpenRoot: async () => {
        await rename(stableRoot, movedRoot);
        await mkdir(stableRoot);
      },
    },
  })));
});

test("scanJobsStorage rejects repeated directory inodes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-repeat-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "a"));
  await mkdir(path.join(root, "b"));
  const firstDirectory = await lstat(path.join(root, "a"), { bigint: true });
  const fakeRepeated = ({ stat: item, name }) => name === "b"
    ? { ...item, dev: firstDirectory.dev, ino: firstDirectory.ino }
    : item;
  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, {
    hooks: { afterLstat: fakeRepeated, afterFstat: fakeRepeated },
  })));
});

test("scanJobsStorage enforces entry, depth, and deadline bounds", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "one"), "1");
  await writeFile(path.join(root, "two"), "2");
  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, { maxEntries: 1 })));

  await rm(path.join(root, "one"));
  await rm(path.join(root, "two"));
  await mkdir(path.join(root, "level1", "level2"), { recursive: true });
  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, { maxDepth: 1 })));

  let tick = 0;
  await rejectsUnavailable(scanJobsStorage(scanDefaults(root, {
    deadlineMs: 5,
    now: () => tick++ === 0 ? 0 : 5,
  })));
});

test("scanJobsStorage accounts allocated blocks for large and sparse files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-allocation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const largePath = path.join(root, "large.bin");
  await writeFile(largePath, Buffer.alloc(2 * 1024 * 1024, 1));
  const largeStat = await stat(largePath, { bigint: true });
  let result = await scanJobsStorage(scanDefaults(root));
  assert.equal(result.allocatedBytes, largeStat.blocks * 512n);

  await rm(largePath);
  const sparsePath = path.join(root, "sparse.bin");
  const sparse = await open(sparsePath, "w");
  await sparse.truncate(64 * 1024 * 1024);
  await sparse.close();
  const sparseStat = await stat(sparsePath, { bigint: true });
  result = await scanJobsStorage(scanDefaults(root));
  assert.equal(result.allocatedBytes, sparseStat.blocks * 512n);
  assert.ok(result.allocatedBytes < sparseStat.size);
});

test("scanJobsStorage never calls deletion APIs or changes content", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "storage-readonly-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "preserved.bin");
  await writeFile(file, "preserve exactly");
  const before = await lstat(file, { bigint: true });
  const guardedOps = new Proxy(fs.promises, {
    get(target, property, receiver) {
      if (property === "rm" || property === "unlink") throw new Error(`mutation API accessed: ${String(property)}`);
      return Reflect.get(target, property, receiver);
    },
  });

  await scanJobsStorage(scanDefaults(root, { ops: guardedOps }));

  const after = await lstat(file, { bigint: true });
  assert.equal(await readFile(file, "utf8"), "preserve exactly");
  assert.equal(after.ino, before.ino);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeNs, before.mtimeNs);
});
