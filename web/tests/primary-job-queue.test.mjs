import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validatePrimaryRequestLength } from "../app/api/jobs/route.js";
import {
  ACTIVE_PRIMARY_STATUSES,
  LeaseLostError,
  QueueCapacityError,
  QueueStateError,
  abortAdmissionStaging,
  cancelAdmission,
  claimNextJob,
  fencedUpdateJob,
  parsePrimaryQueueConfig,
  publishAttemptAndComplete,
  publishReservedQueuedJob,
  publishQueuedJob,
  reserveAdmission,
  recheckAdmission,
  publishFailedAdmissionJob,
  renewAdmission,
  withPrimaryQueueLock,
} from "../lib/primary-job-queue.mjs";
import { heartbeatRenderStorage, reserveRenderStorage } from "../lib/render-storage-admission.mjs";

async function root() {
  return mkdtemp(path.join(os.tmpdir(), "primary-queue-"));
}

async function persisted(jobsRoot, id) {
  return JSON.parse(await readFile(path.join(jobsRoot, id, "job.json"), "utf8"));
}

function job(id, status = "queued", extra = {}) {
  return {
    id,
    status,
    progress: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "upload", name: "source.mp4" },
    sourcePath: `/data/jobs/${id}/input/source.mp4`,
    options: { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 },
    clips: [],
    ...extra,
  };
}

async function seed(jobsRoot, value) {
  const directory = path.join(jobsRoot, value.id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "job.json"), `${JSON.stringify(value)}\n`);
}

test("primary queue config is bounded and fails closed", () => {
  assert.deepEqual(parsePrimaryQueueConfig({ PRIMARY_MAX_ACTIVE_JOBS: "4", PRIMARY_WORKER_CONCURRENCY: "1", PRIMARY_MAX_ATTEMPTS: "3", PRIMARY_LEASE_MS: "60000" }), {
    maxActiveJobs: 4, concurrency: 1, maxAttempts: 3, leaseMs: 60000, legacyQuiescenceMs: 300000,
  });
  for (const env of [
    {},
    { PRIMARY_MAX_ACTIVE_JOBS: "0", PRIMARY_WORKER_CONCURRENCY: "1", PRIMARY_MAX_ATTEMPTS: "3", PRIMARY_LEASE_MS: "60000" },
    { PRIMARY_MAX_ACTIVE_JOBS: "4x", PRIMARY_WORKER_CONCURRENCY: "1", PRIMARY_MAX_ATTEMPTS: "3", PRIMARY_LEASE_MS: "60000" },
    { PRIMARY_MAX_ACTIVE_JOBS: "4", PRIMARY_WORKER_CONCURRENCY: "5", PRIMARY_MAX_ATTEMPTS: "3", PRIMARY_LEASE_MS: "60000" },
  ]) assert.throws(() => parsePrimaryQueueConfig(env), /primary queue configuration/i);
});

test("multipart requests require a bounded Content-Length before form buffering", () => {
  const env = { MAX_UPLOAD_BYTES: "1000" };
  assert.equal(validatePrimaryRequestLength(new Headers({ "content-length": "1200" }), env), 1200);
  assert.throws(() => validatePrimaryRequestLength(new Headers(), env), /content-length/i);
  assert.throws(() => validatePrimaryRequestLength(new Headers({ "content-length": "1049577" }), env), /request.*large/i);
  for (const invalid of [undefined, "0", "1e3", "1000x"]) {
    assert.throws(() => validatePrimaryRequestLength(new Headers({ "content-length": "100" }), { MAX_UPLOAD_BYTES: invalid }), /upload configuration/i);
  }
});

test("atomic admission never publishes more than the configured active bound", async () => {
  const jobsRoot = await root();
  const [left, right] = await Promise.allSettled([
    publishQueuedJob(jobsRoot, job("11111111-1111-4111-8111-111111111111"), 1),
    publishQueuedJob(jobsRoot, job("22222222-2222-4222-8222-222222222222"), 1),
  ]);
  assert.equal([left, right].filter((item) => item.status === "fulfilled").length, 1);
  const rejection = [left, right].find((item) => item.status === "rejected");
  assert.ok(rejection.reason instanceof QueueCapacityError);
  const winner = [left, right].find((item) => item.status === "fulfilled").value;
  assert.equal(winner.status, "queued");
  assert.deepEqual(winner.queue, { version: 1, attempts: 0 });
  assert.equal((await persisted(jobsRoot, winner.id)).status, "queued");
});

test("admission counts every handoff and running state but not terminal jobs", async () => {
  assert.deepEqual([...ACTIVE_PRIMARY_STATUSES], ["queued", "preparing", "downloading", "processing"]);
  const jobsRoot = await root();
  await seed(jobsRoot, job("33333333-3333-4333-8333-333333333333", "processing"));
  await seed(jobsRoot, job("44444444-4444-4444-8444-444444444444", "completed"));
  await assert.rejects(
    publishQueuedJob(jobsRoot, job("55555555-5555-4555-8555-555555555555"), 1),
    QueueCapacityError,
  );
});

test("claim uses a lease token, skips live leases, and recovers expired work", async () => {
  const jobsRoot = await root();
  const first = job("66666666-6666-4666-8666-666666666666");
  await seed(jobsRoot, first);
  const claimed = await claimNextJob({ jobsRoot, workerId: "worker-a", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0, now: Date.parse("2026-01-01T00:01:00.000Z") });
  assert.equal(claimed.job.status, "preparing");
  assert.equal(claimed.job.queue.attempts, 1);
  assert.equal(claimed.job.queue.lease.owner, "worker-a");
  assert.equal(claimed.job.queue.lease.token, undefined);
  assert.match(claimed.job.queue.lease.tokenHash, /^[0-9a-f]{64}$/);
  assert.match(claimed.token, /^[0-9a-f-]{36}$/);
  assert.doesNotMatch(JSON.stringify(await persisted(jobsRoot, first.id)), new RegExp(claimed.token));
  assert.equal(await claimNextJob({ jobsRoot, workerId: "worker-b", leaseMs: 60_000, maxAttempts: 3, now: Date.parse("2026-01-01T00:01:30.000Z") }), null);

  const recovered = await claimNextJob({ jobsRoot, workerId: "worker-b", leaseMs: 60_000, maxAttempts: 3, now: Date.parse("2026-01-01T00:02:01.000Z") });
  assert.equal(recovered.job.queue.attempts, 2);
  assert.equal(recovered.job.queue.lease.owner, "worker-b");
  assert.notEqual(recovered.token, claimed.token);
});

test("legacy active jobs are reconciled, completed jobs are never claimed, and attempts are bounded", async () => {
  const jobsRoot = await root();
  await seed(jobsRoot, job("77777777-7777-4777-8777-777777777777", "completed"));
  await seed(jobsRoot, job("88888888-8888-4888-8888-888888888888", "downloading"));
  const legacy = await claimNextJob({ jobsRoot, workerId: "worker", leaseMs: 60_000, maxAttempts: 1, legacyQuiescenceMs: 0, now: Date.parse("2026-01-01T00:01:00.000Z") });
  assert.equal(legacy.job.id, "88888888-8888-4888-8888-888888888888");
  assert.equal(legacy.job.queue.attempts, 1);
  const exhausted = await claimNextJob({ jobsRoot, workerId: "worker", leaseMs: 60_000, maxAttempts: 1, now: Date.parse("2026-01-01T00:03:00.000Z") });
  assert.equal(exhausted, null);
  const failed = await persisted(jobsRoot, legacy.job.id);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /maximum attempts/i);
  assert.equal((await persisted(jobsRoot, "77777777-7777-4777-8777-777777777777")).status, "completed");
});

test("fenced updates heartbeat the current lease and reject stale workers", async () => {
  const jobsRoot = await root();
  const id = "99999999-9999-4999-8999-999999999999";
  await seed(jobsRoot, job(id));
  const claim = await claimNextJob({ jobsRoot, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0, now: Date.parse("2026-01-01T00:01:00.000Z") });
  const updated = await fencedUpdateJob({ jobsRoot, id, token: claim.token, leaseMs: 60_000, now: Date.parse("2026-01-01T00:01:30.000Z"), patch: { status: "processing", progress: 25 } });
  assert.equal(updated.progress, 25);
  assert.equal(updated.queue.lease.expiresAt, "2026-01-01T00:02:30.000Z");
  await assert.rejects(
    fencedUpdateJob({ jobsRoot, id, token: "stale-token", leaseMs: 60_000, patch: { status: "completed" } }),
    LeaseLostError,
  );
});

test("admission reservations consume capacity before publication and roll back by token", async () => {
  const jobsRoot = await root();
  const reservation = await reserveAdmission(jobsRoot, 1);
  await assert.rejects(reserveAdmission(jobsRoot, 1), QueueCapacityError);
  await cancelAdmission(jobsRoot, { ...reservation, token: "wrong" });
  await assert.rejects(reserveAdmission(jobsRoot, 1), QueueCapacityError);
  await cancelAdmission(jobsRoot, reservation);
  assert.ok(await reserveAdmission(jobsRoot, 1));
});

test("unknown queue versions fail closed and are never downgraded", async () => {
  const jobsRoot = await root();
  const id = "10101010-1010-4010-8010-101010101010";
  await seed(jobsRoot, job(id, "queued", { queue: { version: 2, attempts: 0 } }));
  await assert.rejects(claimNextJob({ jobsRoot, workerId: "worker", leaseMs: 60_000, maxAttempts: 3 }), QueueStateError);
  assert.equal((await persisted(jobsRoot, id)).queue.version, 2);
});

test("tampered identities, non-UUID directories, and symlinked job state fail safely", async () => {
  const jobsRoot = await root();
  const id = "20202020-2020-4020-8020-202020202020";
  await seed(jobsRoot, job(id));
  await writeFile(path.join(jobsRoot, id, "job.json"), JSON.stringify(job("30303030-3030-4030-8030-303030303030")));
  await assert.rejects(claimNextJob({ jobsRoot, workerId: "w", leaseMs: 60_000, maxAttempts: 3 }), QueueStateError);
  const clean = await root();
  await mkdir(path.join(clean, "not-a-uuid"));
  await writeFile(path.join(clean, "not-a-uuid", "job.json"), "{}\n");
  await assert.rejects(claimNextJob({ jobsRoot: clean, workerId: "w", leaseMs: 60_000, maxAttempts: 3 }), QueueStateError);
  const linked = await root();
  const outside = await root();
  await writeFile(path.join(outside, "job.json"), JSON.stringify(job(id)));
  await symlink(outside, path.join(linked, id));
  await assert.rejects(claimNextJob({ jobsRoot: linked, workerId: "w", leaseMs: 60_000, maxAttempts: 3 }), QueueStateError);
});

test("legacy active migration requires explicit quiescence and invalid timestamps fail safe", async () => {
  const jobsRoot = await root();
  const now = Date.parse("2026-01-01T00:10:00.000Z");
  const id = "40404040-4040-4040-8040-404040404040";
  await seed(jobsRoot, job(id, "processing", { updatedAt: "2026-01-01T00:09:59.000Z" }));
  assert.equal(await claimNextJob({ jobsRoot, workerId: "w", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 300_000, now }), null);
  await writeFile(path.join(jobsRoot, id, "job.json"), JSON.stringify(job(id, "processing", { updatedAt: "invalid" })));
  assert.equal(await claimNextJob({ jobsRoot, workerId: "w", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 300_000, now }), null);
  await writeFile(path.join(jobsRoot, id, "job.json"), JSON.stringify(job(id, "processing", { updatedAt: "2026-01-01T00:00:00.000Z" })));
  assert.equal((await claimNextJob({ jobsRoot, workerId: "w", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 300_000, now })).job.id, id);
});

test("only the current lease can atomically publish an isolated attempt", async () => {
  const jobsRoot = await root();
  const id = "50505050-5050-4050-8050-505050505050";
  await seed(jobsRoot, job(id));
  const now = Date.parse("2026-01-01T00:01:00.000Z");
  const first = await claimNextJob({ jobsRoot, workerId: "old", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0, now });
  const firstOutput = path.join(jobsRoot, id, ".attempts", "old", "output");
  await mkdir(firstOutput, { recursive: true });
  await writeFile(path.join(firstOutput, "manifest.json"), "old");
  const second = await claimNextJob({ jobsRoot, workerId: "new", leaseMs: 60_000, maxAttempts: 3, now: now + 61_000 });
  const secondOutput = path.join(jobsRoot, id, ".attempts", "new", "output");
  await mkdir(secondOutput, { recursive: true });
  await writeFile(path.join(secondOutput, "manifest.json"), "new");
  await assert.rejects(publishAttemptAndComplete({ jobsRoot, id, token: first.token, attemptOutput: firstOutput, patch: { status: "completed" } }), LeaseLostError);
  await assert.rejects(stat(path.join(jobsRoot, id, "output")), { code: "ENOENT" });
  const completed = await publishAttemptAndComplete({ jobsRoot, id, token: second.token, attemptOutput: secondOutput, patch: { status: "completed", progress: 100 } });
  assert.equal(completed.status, "completed");
  assert.equal(await readFile(path.join(jobsRoot, id, "output", "manifest.json"), "utf8"), "new");
  assert.equal(await readFile(path.join(firstOutput, "manifest.json"), "utf8"), "old");
});

test("a live lock heartbeat prevents overlap beyond the stale interval", async () => {
  const jobsRoot = await root();
  let firstInside = false;
  let overlap = false;
  let releaseFirst;
  const holdFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const enteredFirst = Promise.withResolvers();

  const first = withPrimaryQueueLock(jobsRoot, async () => {
    firstInside = true;
    enteredFirst.resolve();
    await holdFirst;
    firstInside = false;
  }, { staleMs: 30, timeoutMs: 500, retryDelayMs: 2 });
  await enteredFirst.promise;

  const second = withPrimaryQueueLock(jobsRoot, async () => {
    overlap = firstInside;
  }, { staleMs: 30, timeoutMs: 500, retryDelayMs: 2 });
  await new Promise((resolve) => setTimeout(resolve, 90));
  releaseFirst();
  await Promise.all([first, second]);
  assert.equal(overlap, false);
});

test("lock ownership loss aborts the callback and fails closed", async () => {
  const jobsRoot = await root();
  const ownerPath = path.join(jobsRoot, ".primary-queue.lock", "owner.json");
  await assert.rejects(withPrimaryQueueLock(jobsRoot, async (signal) => {
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    await writeFile(ownerPath, JSON.stringify({ ...owner, token: "replacement-owner" }));
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
  }, { staleMs: 30, timeoutMs: 300, retryDelayMs: 2 }), /heartbeat failed/i);
});

test("lock ownership loss at callback completion fails closed and preserves the successor", async () => {
  const jobsRoot = await root();
  const ownerPath = path.join(jobsRoot, ".primary-queue.lock", "owner.json");
  await assert.rejects(withPrimaryQueueLock(jobsRoot, async () => {
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    await writeFile(ownerPath, JSON.stringify({ ...owner, token: "replacement-owner" }));
  }, { staleMs: 30, timeoutMs: 300, retryDelayMs: 2 }), /lease was lost/i);
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).token, "replacement-owner");
});

test("callback failure takes precedence over final ownership failure", async () => {
  const jobsRoot = await root();
  const ownerPath = path.join(jobsRoot, ".primary-queue.lock", "owner.json");
  const callbackFailure = new Error("callback failure");
  await assert.rejects(withPrimaryQueueLock(jobsRoot, async () => {
    const owner = JSON.parse(await readFile(ownerPath, "utf8"));
    await writeFile(ownerPath, JSON.stringify({ ...owner, token: "replacement-owner" }));
    throw callbackFailure;
  }), (error) => error === callbackFailure);
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).token, "replacement-owner");
});

test("an old lock owner cannot remove a successor lock during release", async () => {
  const jobsRoot = await root();
  const lockPath = path.join(jobsRoot, ".primary-queue.lock");
  await assert.rejects(withPrimaryQueueLock(jobsRoot, async () => {
    await rename(lockPath, `${lockPath}.old`);
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "successor", pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() }));
  }), /lease was lost/i);
  assert.equal((await stat(lockPath)).isDirectory(), true);
  assert.equal(JSON.parse(await readFile(path.join(lockPath, "owner.json"), "utf8")).token, "successor");
});

test("an empty partial lock is recovered after its bounded stale age", async () => {
  const jobsRoot = await root();
  const lockPath = path.join(jobsRoot, ".primary-queue.lock");
  await mkdir(lockPath);
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);
  let entered = false;
  await withPrimaryQueueLock(jobsRoot, async () => { entered = true; }, { staleMs: 20, timeoutMs: 200, retryDelayMs: 5 });
  assert.equal(entered, true);
});

test("lock timeout and retry delay apply while owner publication is partial", async () => {
  const jobsRoot = await root();
  await mkdir(path.join(jobsRoot, ".primary-queue.lock"));
  const started = Date.now();
  await assert.rejects(
    withPrimaryQueueLock(jobsRoot, async () => {}, { staleMs: 60_000, timeoutMs: 35, retryDelayMs: 10 }),
    /timed out/i,
  );
  assert.ok(Date.now() - started >= 30);
});

test("stale lease age overrides reused hostname and PID", async () => {
  const jobsRoot = await root();
  const lockPath = path.join(jobsRoot, ".primary-queue.lock");
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({
    token: "old-token", pid: process.pid, hostname: os.hostname(), createdAt: new Date(Date.now() - 60_000).toISOString(),
  }));
  await withPrimaryQueueLock(jobsRoot, async () => {}, { staleMs: 20, timeoutMs: 200, retryDelayMs: 5 });
});

test("published job and matching reservation count as one admission", async () => {
  const jobsRoot = await root();
  const id = "60606060-6060-4060-8060-606060606060";
  const reservation = await reserveAdmission(jobsRoot, 2, id);
  await seed(jobsRoot, job(id, "queued", { queue: { version: 1, attempts: 0 } }));
  assert.ok(await reserveAdmission(jobsRoot, 2, "61616161-6161-4161-8161-616161616161"));
  await assert.rejects(reserveAdmission(jobsRoot, 2), QueueCapacityError);
  await cancelAdmission(jobsRoot, reservation);
});

test("publication retry recovers a durably published job after reservation cleanup", async () => {
  const jobsRoot = await root();
  const id = "62626262-6262-4262-8262-626262626262";
  const reservation = await reserveAdmission(jobsRoot, 1, id);
  const first = await publishReservedQueuedJob(jobsRoot, job(id), reservation);
  const recovered = await publishReservedQueuedJob(jobsRoot, job(id), reservation);
  assert.deepEqual(recovered, first);
});

test("abort cleanup preserves published work but removes unpublished staging", async () => {
  const jobsRoot = await root();
  const publishedId = "63636363-6363-4363-8363-636363636363";
  const publishedReservation = await reserveAdmission(jobsRoot, 2, publishedId);
  await seed(jobsRoot, job(publishedId, "queued", { queue: { version: 1, attempts: 0 } }));
  assert.equal((await abortAdmissionStaging(jobsRoot, publishedReservation)).published, true);
  assert.equal((await persisted(jobsRoot, publishedId)).status, "queued");

  const stagedId = "64646464-6464-4464-8464-646464646464";
  const stagedReservation = await reserveAdmission(jobsRoot, 2, stagedId);
  await mkdir(path.join(jobsRoot, stagedId, "input"), { recursive: true });
  assert.equal((await abortAdmissionStaging(jobsRoot, stagedReservation)).published, false);
  assert.equal((await stat(path.join(jobsRoot, stagedId))).isDirectory(), true);
});

const storageConfig = {
  quotaBytes: 100n,
  minimumFreeBytes: 0n,
  activeReserveBytes: 10n,
  scanMaxEntries: 100,
  scanMaxDepth: 10,
  scanDeadlineMs: 1000,
  recheckIntervalMs: 100,
  recheckBytes: 8 * 1024 * 1024,
};
const storageOps = (allocatedBytes = 0n, availableBytes = 1000n) => ({
  scan: async () => ({ allocatedBytes }),
  available: async () => availableBytes,
});

test("byte and queue reservations are atomic and exact quota equality is allowed", async () => {
  const jobsRoot = await root();
  const ops = storageOps(0n);
  const [left, right] = await Promise.allSettled([
    reserveAdmission(jobsRoot, 2, "70707070-7070-4070-8070-707070707070", { declaredRequestBytes: 45n, storageConfig, storageOps: ops }),
    reserveAdmission(jobsRoot, 2, "71717171-7171-4171-8171-717171717171", { declaredRequestBytes: 45n, storageConfig, storageOps: ops }),
  ]);
  assert.equal([left, right].filter((value) => value.status === "fulfilled").length, 1);
  assert.equal([left, right].find((value) => value.status === "rejected").reason.code, "storage_quota_exhausted");
});

test("reservation schema v2 is strict and consumption is token fenced", async () => {
  const jobsRoot = await root();
  const id = "72727272-7272-4272-8272-727272727272";
  const reservation = await reserveAdmission(jobsRoot, 2, id, { declaredRequestBytes: 40n, storageConfig, storageOps: storageOps() });
  const target = path.join(jobsRoot, ".primary-reservations", `${id}.json`);
  const stored = JSON.parse(await readFile(target, "utf8"));
  assert.deepEqual(stored, {
    version: 2, id, tokenHash: stored.tokenHash, createdAt: stored.createdAt, expiresAt: stored.expiresAt,
    declaredRequestBytes: "40", consumedRequestBytes: "0", remainingRequestBytes: "40", workReserveBytes: "10",
  });
  assert.equal(await recheckAdmission(jobsRoot, { ...reservation, token: "wrong" }, 8n, storageConfig, storageOps()), false);
  assert.equal((JSON.parse(await readFile(target, "utf8"))).consumedRequestBytes, "0");
  assert.equal(await recheckAdmission(jobsRoot, reservation, 8n, storageConfig, storageOps()), true);
  assert.equal((JSON.parse(await readFile(target, "utf8"))).remainingRequestBytes, "32");
  await writeFile(target, JSON.stringify({ ...stored, version: 99 }));
  await assert.rejects(reserveAdmission(jobsRoot, 2, "73737373-7373-4373-8373-737373737373", { declaredRequestBytes: 1n, storageConfig, storageOps: storageOps() }), QueueStateError);
});

test("post-staging storage failure publishes a fenced terminal job and preserves bytes", async () => {
  const jobsRoot = await root();
  const id = "74747474-7474-4474-8474-747474747474";
  const reservation = await reserveAdmission(jobsRoot, 2, id, { declaredRequestBytes: 40n, storageConfig, storageOps: storageOps() });
  await mkdir(path.join(jobsRoot, id, "input"), { recursive: true });
  await writeFile(path.join(jobsRoot, id, "input", "source.mp4"), "partial");
  const failed = await publishFailedAdmissionJob(jobsRoot, reservation, "storage_free_space_low");
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "storage_free_space_low");
  assert.equal(await readFile(path.join(jobsRoot, id, "input", "source.mp4"), "utf8"), "partial");
  assert.equal((await persisted(jobsRoot, id)).status, "failed");
});

test("reservation renewal prevents stale cleanup during a long upload", async () => {
  const jobsRoot = await root();
  const id = "65656565-6565-4565-8565-656565656565";
  const reservation = await reserveAdmission(jobsRoot, 1, id);
  const reservationPath = path.join(jobsRoot, ".primary-reservations", `${id}.json`);
  const stored = JSON.parse(await readFile(reservationPath, "utf8"));
  await writeFile(reservationPath, JSON.stringify({ ...stored, expiresAt: "2000-01-01T00:00:00.000Z" }));
  assert.equal(await renewAdmission(jobsRoot, reservation), true);
  await assert.rejects(reserveAdmission(jobsRoot, 1), QueueCapacityError);
});

test("expired deployed v1 reservations are cleaned but live v1 reservations fail closed with a bounded retry", async () => {
  const jobsRoot = await root();
  const directory = path.join(jobsRoot, ".primary-reservations");
  await mkdir(directory, { recursive: true });
  const expiredId = "75757575-7575-4575-8575-757575757575";
  await writeFile(path.join(directory, `${expiredId}.json`), JSON.stringify({
    version: 1, id: expiredId, tokenHash: "a".repeat(64),
    createdAt: "2000-01-01T00:00:00.000Z", expiresAt: "2000-01-01T01:00:00.000Z",
  }));
  assert.ok(await reserveAdmission(jobsRoot, 2, "76767676-7676-4676-8676-767676767676"));

  const liveId = "77777777-7777-4777-8777-777777777770";
  await writeFile(path.join(directory, `${liveId}.json`), JSON.stringify({
    version: 1, id: liveId, tokenHash: "b".repeat(64),
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }));
  await assert.rejects(
    reserveAdmission(jobsRoot, 4, "78787878-7878-4878-8878-787878787878"),
    (error) => error instanceof QueueStateError && error.code === "legacy_reservation_live"
      && Number.isSafeInteger(error.retryAfterMs) && error.retryAfterMs >= 1 && error.retryAfterMs <= 3_600_000,
  );
});

test("storage scans complete outside the global queue lock", async () => {
  const jobsRoot = await root();
  const scanStarted = Promise.withResolvers();
  const releaseScan = Promise.withResolvers();
  const admission = reserveAdmission(jobsRoot, 2, "79797979-7979-4979-8979-797979797979", {
    declaredRequestBytes: 1n,
    storageConfig,
    storageOps: {
      scan: async () => { scanStarted.resolve(); await releaseScan.promise; return { allocatedBytes: 0n }; },
      available: async () => 1000n,
    },
  });
  await scanStarted.promise;
  let entered = false;
  await withPrimaryQueueLock(jobsRoot, async () => { entered = true; });
  assert.equal(entered, true);
  releaseScan.resolve();
  assert.ok(await admission);
});

test("primary and render reservations share one quota in both admission orderings", async () => {
  for (const renderFirst of [true, false]) {
    const jobsRoot = await root();
    const renderId = renderFirst ? "84848484-8484-4484-8484-848484848484" : "85858585-8585-4585-8585-858585858585";
    const primaryId = renderFirst ? "86868686-8686-4686-8686-868686868686" : "87878787-8787-4787-8787-878787878787";
    const renderOptions = { reservationId: renderId, jobId: renderId, declaredBytes: 80n, storageConfig, storageOps: storageOps() };
    const primaryOptions = { declaredRequestBytes: 1n, storageConfig, storageOps: storageOps() };
    if (renderFirst) {
      await reserveRenderStorage(jobsRoot, renderOptions);
      await assert.rejects(reserveAdmission(jobsRoot, 2, primaryId, primaryOptions), (error) => error.code === "storage_quota_exhausted");
    } else {
      await reserveAdmission(jobsRoot, 2, primaryId, primaryOptions);
      await assert.rejects(reserveRenderStorage(jobsRoot, renderOptions), (error) => error.code === "storage_quota_exhausted");
    }
  }
});

test("render admission includes active primary growth reserve", async () => {
  const jobsRoot = await root();
  const activeId = "88888888-8888-4888-8888-888888888888";
  await seed(jobsRoot, job(activeId, "processing", { queue: { version: 1, attempts: 1 } }));
  await assert.rejects(reserveRenderStorage(jobsRoot, {
    reservationId: "89898989-8989-4989-8989-898989898989", jobId: activeId,
    declaredBytes: 81n, storageConfig, storageOps: storageOps(),
  }), (error) => error.code === "storage_quota_exhausted");
});

test("render scans and heartbeat scans complete outside the shared lock", async () => {
  const jobsRoot = await root();
  const scanStarted = Promise.withResolvers();
  const releaseScan = Promise.withResolvers();
  const reservationId = "90909090-9090-4090-8090-909090909090";
  const admission = reserveRenderStorage(jobsRoot, {
    reservationId, jobId: reservationId, declaredBytes: 1n, storageConfig,
    storageOps: { scan: async () => { scanStarted.resolve(); await releaseScan.promise; return { allocatedBytes: 0n }; }, available: async () => 1000n },
  });
  await scanStarted.promise;
  await withPrimaryQueueLock(jobsRoot, async () => {});
  releaseScan.resolve();
  const reservation = await admission;
  const heartbeatStarted = Promise.withResolvers();
  const releaseHeartbeat = Promise.withResolvers();
  const checking = heartbeatRenderStorage(jobsRoot, reservationId, reservation.token, storageConfig, {
    scan: async () => { heartbeatStarted.resolve(); await releaseHeartbeat.promise; return { allocatedBytes: 0n }; }, available: async () => 1000n,
  });
  await heartbeatStarted.promise;
  await withPrimaryQueueLock(jobsRoot, async () => {});
  releaseHeartbeat.resolve();
  assert.equal(await checking, true);
});

test("expired reservations with staged bytes recover as visible failed jobs", async () => {
  const jobsRoot = await root();
  const id = "80808080-8080-4080-8080-808080808080";
  await reserveAdmission(jobsRoot, 2, id);
  await mkdir(path.join(jobsRoot, id, "input"), { recursive: true });
  await writeFile(path.join(jobsRoot, id, "input", "partial.mp4"), "partial bytes");
  const target = path.join(jobsRoot, ".primary-reservations", `${id}.json`);
  const stored = JSON.parse(await readFile(target, "utf8"));
  await writeFile(target, JSON.stringify({ ...stored, expiresAt: "2000-01-01T00:00:00.000Z" }));
  await reserveAdmission(jobsRoot, 2, "81818181-8181-4181-8181-818181818181");
  const recovered = await persisted(jobsRoot, id);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error, "storage_admission_unavailable");
  assert.equal(await readFile(path.join(jobsRoot, id, "input", "partial.mp4"), "utf8"), "partial bytes");
});

test("lost reservations leave staged bytes recoverable as a visible sanitized failure", async () => {
  const jobsRoot = await root();
  const id = "82828282-8282-4282-8282-828282828282";
  await reserveAdmission(jobsRoot, 2, id);
  await mkdir(path.join(jobsRoot, id, "input"), { recursive: true });
  await writeFile(path.join(jobsRoot, id, "input", "partial.mp4"), "recover me");
  await unlink(path.join(jobsRoot, ".primary-reservations", `${id}.json`));

  await reserveAdmission(jobsRoot, 2, "83838383-8383-4383-8383-838383838383");

  const recovered = await persisted(jobsRoot, id);
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.error, "storage_admission_unavailable");
  assert.doesNotMatch(JSON.stringify(recovered), /primary-reservations|\/tmp\//);
});
