// "Batalkan" for a queued or running job: the queue state change and the route. The runner side
// (child processes that must die) is in job-cancel-runner.test.mjs, the pages in
// job-cancel-view.test.mjs.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { requestJobDeletion } from "../lib/job-deletion.mjs";
import {
  CANCELLED_STATUS,
  cancelPrimaryJob,
  claimNextJob,
  fencedUpdateJob,
  LeaseLostError,
  leaseHeld,
} from "../lib/primary-job-queue.mjs";
import { readSharedStorageAccounting } from "../lib/shared-storage-accounting.mjs";

const NOW = Date.parse("2026-10-21T08:00:00.000Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

async function jobsRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potongin-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function baseJob(id = crypto.randomUUID(), extra = {}) {
  return {
    id,
    status: "queued",
    progress: 0,
    stage: "queued",
    createdAt: iso(-60_000),
    updatedAt: iso(-60_000),
    source: { type: "youtube", url: "https://youtu.be/abc" },
    sourcePath: null,
    options: { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60 },
    clips: [],
    queue: { version: 1, attempts: 0 },
    ...extra,
  };
}

function runningJob(id = crypto.randomUUID(), leaseOffsetMs = 45_000) {
  return baseJob(id, {
    status: "processing",
    progress: 42,
    stage: "transcribing",
    stageDetail: "Transkripsi audio 40%",
    queue: {
      version: 1,
      attempts: 1,
      lease: {
        tokenHash: "a".repeat(64),
        owner: "worker:1",
        claimedAt: iso(-15_000),
        heartbeatAt: iso(-5_000),
        expiresAt: iso(leaseOffsetMs),
      },
    },
  });
}

async function writeJob(root, job) {
  const jobRoot = path.join(root, job.id);
  await mkdir(jobRoot, { recursive: true });
  await writeFile(path.join(jobRoot, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  return jobRoot;
}

const readJob = async (root, id) => JSON.parse(await readFile(path.join(root, id, "job.json"), "utf8"));
const exists = async (target) => {
  try { await stat(target); return true; } catch { return false; }
};

// --- queue state --------------------------------------------------------------------------------

test("cancelling a queued job takes it out of the queue for good", async (t) => {
  const root = await jobsRoot(t);
  const job = baseJob();
  await writeJob(root, job);

  const result = await cancelPrimaryJob({ jobsRoot: root, id: job.id, now: NOW });
  assert.equal(result.outcome, "cancelled");
  assert.equal(result.job.status, CANCELLED_STATUS);
  assert.equal(CANCELLED_STATUS, "cancelled");

  const persisted = await readJob(root, job.id);
  assert.equal(persisted.status, "cancelled");
  assert.equal(persisted.stage, "cancelled");
  assert.equal(persisted.error, null);
  assert.deepEqual(persisted.queue, { version: 1, attempts: 0 });
  assert.deepEqual(persisted.cancellation, { requestedAt: iso(0), previousStatus: "queued", safeAfter: iso(0) });
  assert.equal(persisted.updatedAt, iso(0));

  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, now: NOW + 1_000 });
  assert.equal(claim, null, "a cancelled job is never claimed");
});

test("cancelling a running job revokes its lease, keeps its progress and records the old lease window", async (t) => {
  const root = await jobsRoot(t);
  const job = runningJob();
  await writeJob(root, job);

  const result = await cancelPrimaryJob({ jobsRoot: root, id: job.id, now: NOW });
  assert.equal(result.outcome, "cancelled");
  const persisted = await readJob(root, job.id);
  assert.equal(persisted.status, "cancelled");
  assert.equal(persisted.progress, 42, "the bar stays where the job stopped");
  assert.equal(persisted.queue.lease, undefined, "the runner's next fenced write or lease check fails");
  assert.deepEqual(persisted.queue, { version: 1, attempts: 1 });
  assert.equal(persisted.cancellation.previousStatus, "processing");
  assert.equal(persisted.cancellation.safeAfter, iso(45_000));
});

test("the runner's fence fails once the job is cancelled", async (t) => {
  const root = await jobsRoot(t);
  await writeJob(root, baseJob("11111111-2222-4333-8444-555555555555"));
  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, now: NOW });
  assert.ok(claim);
  assert.equal(await leaseHeld({ jobsRoot: root, id: claim.job.id, token: claim.token }), true);
  assert.equal(await leaseHeld({ jobsRoot: root, id: claim.job.id, token: "another-token" }), false);

  await cancelPrimaryJob({ jobsRoot: root, id: claim.job.id, now: NOW + 1_000 });
  assert.equal(await leaseHeld({ jobsRoot: root, id: claim.job.id, token: claim.token }), false);
  await assert.rejects(
    fencedUpdateJob({ jobsRoot: root, id: claim.job.id, token: claim.token, leaseMs: 60_000, patch: { status: "processing", progress: 50 } }),
    LeaseLostError,
  );
  assert.equal((await readJob(root, claim.job.id)).status, "cancelled", "a late progress write cannot revive the job");
});

test("leaseHeld reads without the queue lock and calls a missing job gone", async (t) => {
  const root = await jobsRoot(t);
  assert.equal(await leaseHeld({ jobsRoot: root, id: crypto.randomUUID(), token: "token" }), false);
  const broken = crypto.randomUUID();
  await mkdir(path.join(root, broken), { recursive: true });
  await writeFile(path.join(root, broken, "job.json"), "{not json");
  assert.equal(await leaseHeld({ jobsRoot: root, id: broken, token: "token" }), null, "unreadable state is no verdict");
});

test("a legacy job without queue state is fenced as well", async (t) => {
  const root = await jobsRoot(t);
  const job = baseJob(crypto.randomUUID(), { status: "downloading" });
  delete job.queue;
  await writeJob(root, job);
  await cancelPrimaryJob({ jobsRoot: root, id: job.id, now: NOW });
  const persisted = await readJob(root, job.id);
  assert.equal(persisted.status, "cancelled");
  assert.deepEqual(persisted.queue, { version: 1, attempts: 0 }, "the legacy runner stops when queue state appears");
});

test("cancelling twice answers the same, and finished or deleting jobs are left untouched", async (t) => {
  const root = await jobsRoot(t);
  const running = runningJob();
  await writeJob(root, running);
  await cancelPrimaryJob({ jobsRoot: root, id: running.id, now: NOW });
  const before = await readJob(root, running.id);
  const again = await cancelPrimaryJob({ jobsRoot: root, id: running.id, now: NOW + 5_000 });
  assert.equal(again.outcome, "already_cancelled");
  assert.deepEqual(await readJob(root, running.id), before, "a second cancel writes nothing");

  for (const status of ["completed", "failed", "deleting"]) {
    const job = baseJob(crypto.randomUUID(), { status, progress: 100 });
    await writeJob(root, job);
    const result = await cancelPrimaryJob({ jobsRoot: root, id: job.id, now: NOW });
    assert.equal(result.outcome, status === "deleting" ? "deleting" : "finished", status);
    assert.equal(result.job.status, status);
    assert.deepEqual(await readJob(root, job.id), job, `${status} stays as it was`);
  }
});

test("an unknown or malformed job id is reported as not found", async (t) => {
  const root = await jobsRoot(t);
  assert.equal((await cancelPrimaryJob({ jobsRoot: root, id: crypto.randomUUID(), now: NOW })).outcome, "not_found");
  assert.equal((await cancelPrimaryJob({ jobsRoot: root, id: "../etc", now: NOW })).outcome, "not_found");
});

test("cancelling releases the job's storage share and any leftover admission record", async (t) => {
  const root = await jobsRoot(t);
  const job = runningJob();
  await writeJob(root, job);
  // A crash between publishing the job and removing its admission record leaves this behind.
  const reservation = path.join(root, ".primary-reservations", `${job.id}.json`);
  await mkdir(path.dirname(reservation), { recursive: true });
  await writeFile(reservation, JSON.stringify({
    version: 2, id: job.id, tokenHash: "c".repeat(64), createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    declaredRequestBytes: "1000", consumedRequestBytes: "0", remainingRequestBytes: "1000", workReserveBytes: "2000",
  }));
  assert.equal((await readSharedStorageAccounting(root)).activePrimaryCount, 1);

  await cancelPrimaryJob({ jobsRoot: root, id: job.id, now: NOW });
  const accounting = await readSharedStorageAccounting(root);
  assert.equal(accounting.activePrimaryCount, 0, "the active reserve is no longer charged");
  assert.equal(accounting.reservedBytes, 0n);
  assert.equal(await exists(reservation), false);
});

test("deleting a cancelled job still waits out the revoked lease window", async (t) => {
  const root = await jobsRoot(t);
  const job = runningJob();
  await writeJob(root, job);
  await cancelPrimaryJob({ jobsRoot: root, id: job.id, now: NOW });
  const { job: deleting } = await requestJobDeletion(root, job.id, { now: NOW + 2_000 });
  assert.equal(deleting.deletion.safeAfter, iso(45_000), "the runner may still be stopping its children");
  assert.equal(deleting.deletion.previousStatus, "cancelled");
});

// --- route ---------------------------------------------------------------------------------------

const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "cancel-route-password",
  APP_SESSION_SECRET: "a-long-random-session-secret-for-cancel",
};

async function callCancel(root, id, { authenticated = true, origin = "http://local", site = "same-origin" } = {}) {
  const { POST } = await import("../app/api/jobs/[id]/cancel/route.js");
  const { createSessionToken } = await import("../lib/auth.mjs");
  const previous = {};
  for (const name of ["JOBS_ROOT", ...Object.keys(AUTH_ENV)]) previous[name] = process.env[name];
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root });
  const headers = { Host: "local" };
  if (site) headers["sec-fetch-site"] = site;
  if (origin) headers.Origin = origin;
  if (authenticated) headers.Cookie = `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}`;
  try {
    const response = await POST(new Request(`http://local/api/jobs/${id}/cancel`, { method: "POST", headers }), {
      params: Promise.resolve({ id }),
    });
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("the cancel route refuses a missing session and changes nothing", async (t) => {
  const root = await jobsRoot(t);
  const job = runningJob();
  await writeJob(root, job);
  const answer = await callCancel(root, job.id, { authenticated: false });
  assert.equal(answer.status, 401);
  assert.equal(answer.headers.get("Cache-Control"), "no-store");
  assert.equal((await readJob(root, job.id)).status, "processing");
});

test("the cancel route refuses a foreign or cross-site origin and changes nothing", async (t) => {
  const root = await jobsRoot(t);
  const job = runningJob();
  await writeJob(root, job);
  for (const request of [
    { origin: "http://evil.example" },
    { origin: null },
    { origin: "http://local", site: "cross-site" },
  ]) {
    const answer = await callCancel(root, job.id, request);
    assert.equal(answer.status, 403, JSON.stringify(request));
    assert.equal(answer.body.code, "csrf_rejected");
  }
  assert.equal((await readJob(root, job.id)).status, "processing");
});

test("the cancel route answers each job state clearly", async (t) => {
  const root = await jobsRoot(t);
  const running = runningJob();
  await writeJob(root, running);
  const cancelled = await callCancel(root, running.id);
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.cancelled, true);
  assert.equal(cancelled.body.job.status, "cancelled");
  assert.equal(cancelled.body.job.sourcePath, undefined, "the response must not leak server paths");
  assert.equal(cancelled.headers.get("Cache-Control"), "no-store");

  const twice = await callCancel(root, running.id);
  assert.equal(twice.status, 200, "a double click is not an error");
  assert.equal(twice.body.cancelled, true);

  const done = baseJob(crypto.randomUUID(), { status: "completed", progress: 100 });
  await writeJob(root, done);
  const finished = await callCancel(root, done.id);
  assert.equal(finished.status, 409);
  assert.equal(finished.body.code, "job_finished");
  assert.equal(finished.body.cancelled, false);
  assert.equal(finished.body.job.status, "completed");
  assert.match(finished.body.error, /sudah selesai/);
  assert.equal((await readJob(root, done.id)).status, "completed");

  const deleting = baseJob(crypto.randomUUID(), { status: "deleting" });
  await writeJob(root, deleting);
  const gone = await callCancel(root, deleting.id);
  assert.equal(gone.status, 409);
  assert.equal(gone.body.code, "job_deleting");

  assert.equal((await callCancel(root, crypto.randomUUID())).status, 404);
  assert.equal((await callCancel(root, "not-a-job")).status, 400);
});

// --- deploy -----------------------------------------------------------------------------------------

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

test("the deploy guard treats a cancelled job as finished work", async () => {
  const script = await read("../../deploy/production.sh");
  assert.match(script, /if status not in \{"completed", "failed", "deleting", "cancelled"\}:/);
});
