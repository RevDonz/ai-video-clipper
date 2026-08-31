import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DELETING_STATUS,
  JobNotFoundError,
  RENDER_LEASE_GRACE_MS,
  purgeBlockedReason,
  purgeDeletedJobs,
  requestJobDeletion,
} from "../lib/job-deletion.mjs";

const NOW = Date.parse("2026-08-31T10:00:00.000Z");
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

async function jobsRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potongin-delete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeJob(root, job) {
  const jobRoot = path.join(root, job.id);
  await mkdir(path.join(jobRoot, "output"), { recursive: true });
  await writeFile(path.join(jobRoot, "job.json"), `${JSON.stringify(job, null, 2)}\n`);
  await writeFile(path.join(jobRoot, "output", "clip-01.mp4"), "not really a video");
  return jobRoot;
}

function completedJob(id = crypto.randomUUID()) {
  return {
    id,
    status: "completed",
    progress: 100,
    createdAt: iso(-3_600_000),
    updatedAt: iso(-60_000),
    source: { type: "youtube", url: "https://youtu.be/abc" },
    sourcePath: null,
    options: { renderMode: "fit-blur", limit: 5, minDuration: 20, maxDuration: 60 },
    clips: [],
    queue: { version: 1, attempts: 1 },
  };
}

function runningJob(id = crypto.randomUUID(), leaseOffsetMs = 45_000) {
  return {
    ...completedJob(id),
    status: "processing",
    progress: 40,
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
  };
}

async function writeRenderReservation(root, { jobId, reservationId = crypto.randomUUID(), heartbeatAt }) {
  const directory = path.join(root, ".render-reservations");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${reservationId}.json`), `${JSON.stringify({
    version: 1,
    reservationId,
    jobId,
    renderId: crypto.randomUUID(),
    state: "active",
    tokenHash: "b".repeat(64),
    declaredBytes: "1000",
    workReserveBytes: "2000",
    createdAt: iso(-60_000),
    heartbeatAt,
    expiresAt: iso(300_000),
  }, null, 2)}\n`);
  return reservationId;
}

const exists = async (target) => {
  try { await stat(target); return true; } catch { return false; }
};

test("deleting a terminal job marks it and becomes purgeable immediately", async (t) => {
  const root = await jobsRoot(t);
  const job = completedJob();
  await writeJob(root, job);

  const marked = await requestJobDeletion(root, job.id, { now: NOW });
  assert.equal(marked.job.status, DELETING_STATUS);

  const persisted = JSON.parse(await readFile(path.join(root, job.id, "job.json"), "utf8"));
  assert.equal(persisted.status, DELETING_STATUS);
  assert.equal(persisted.deletion.requestedAt, iso(0));
  assert.equal(persisted.deletion.safeAfter, iso(0), "a job with no live lease is safe to purge at once");
});

test("deleting a running job revokes the lease so the worker stops itself", async (t) => {
  const root = await jobsRoot(t);
  const job = runningJob();
  await writeJob(root, job);

  await requestJobDeletion(root, job.id, { now: NOW });
  const persisted = JSON.parse(await readFile(path.join(root, job.id, "job.json"), "utf8"));

  assert.equal(persisted.status, DELETING_STATUS);
  assert.equal(persisted.queue.lease, undefined, "a revoked lease makes the runner's next fenced write fail");
  assert.equal(persisted.queue.version, 1);
  assert.equal(
    persisted.deletion.safeAfter,
    iso(45_000),
    "bytes stay until the old lease would have expired, long after the runner is signalled",
  );
});

test("a job that does not exist is reported, not silently accepted", async (t) => {
  const root = await jobsRoot(t);
  await assert.rejects(() => requestJobDeletion(root, crypto.randomUUID(), { now: NOW }), JobNotFoundError);
  await assert.rejects(() => requestJobDeletion(root, "not-a-uuid", { now: NOW }), JobNotFoundError);
});

test("purge waits for the revoked lease window before removing bytes", async (t) => {
  const root = await jobsRoot(t);
  const job = runningJob();
  const jobRoot = await writeJob(root, job);
  await requestJobDeletion(root, job.id, { now: NOW });

  const early = await purgeDeletedJobs(root, { now: NOW + 1_000 });
  assert.deepEqual(early.purged, []);
  assert.deepEqual(early.pending, [{ id: job.id, reason: "primary_lease_live" }]);
  assert.equal(await exists(jobRoot), true);

  const later = await purgeDeletedJobs(root, { now: NOW + 46_000 });
  assert.deepEqual(later.purged, [job.id]);
  assert.equal(await exists(jobRoot), false);
  assert.equal(await exists(path.join(root, ".deletions", `${job.id}.json`)), false);
});

test("purge clears the job's render reservations before its bytes", async (t) => {
  // Storage accounting reads .render-reservations and resolves each one through
  // analysis/render-requests inside the job. Removing the job first would strand
  // a reservation that can never be resolved again, leaking its bytes forever.
  const root = await jobsRoot(t);
  const job = completedJob();
  const other = completedJob();
  await writeJob(root, job);
  await writeJob(root, other);
  const mine = await writeRenderReservation(root, { jobId: job.id, heartbeatAt: iso(-RENDER_LEASE_GRACE_MS - 1_000) });
  const theirs = await writeRenderReservation(root, { jobId: other.id, heartbeatAt: iso(-1_000) });

  await requestJobDeletion(root, job.id, { now: NOW });
  const result = await purgeDeletedJobs(root, { now: NOW });

  assert.deepEqual(result.purged, [job.id]);
  assert.equal(await exists(path.join(root, ".render-reservations", `${mine}.json`)), false);
  assert.equal(await exists(path.join(root, ".render-reservations", `${theirs}.json`)), true, "another job's reservation is untouched");
  assert.equal(await exists(path.join(root, other.id)), true, "another job's bytes are untouched");
});

test("purge refuses while a render worker is still writing into the job", async (t) => {
  const root = await jobsRoot(t);
  const job = completedJob();
  const jobRoot = await writeJob(root, job);
  await writeRenderReservation(root, { jobId: job.id, heartbeatAt: iso(-1_000) });
  await requestJobDeletion(root, job.id, { now: NOW });

  const blocked = await purgeDeletedJobs(root, { now: NOW });
  assert.deepEqual(blocked.pending, [{ id: job.id, reason: "render_reservation_live" }]);
  assert.equal(await exists(jobRoot), true);

  const after = await purgeDeletedJobs(root, { now: NOW + RENDER_LEASE_GRACE_MS + 2_000 });
  assert.deepEqual(after.purged, [job.id]);
  assert.equal(await exists(jobRoot), false);
});

test("an interrupted purge finishes on the next pass", async (t) => {
  const root = await jobsRoot(t);
  const job = completedJob();
  await requestJobDeletionTombstoneOnly(root, job.id);

  const result = await purgeDeletedJobs(root, { now: NOW });
  assert.deepEqual(result.purged, [job.id], "a tombstone whose bytes are already gone is retired");
  assert.equal(await exists(path.join(root, ".deletions", `${job.id}.json`)), false);
});

async function requestJobDeletionTombstoneOnly(root, id) {
  const directory = path.join(root, ".deletions");
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${id}.json`), `${JSON.stringify({
    version: 1, id, requestedAt: iso(0), safeAfter: iso(0),
  }, null, 2)}\n`);
}

test("purge blocking is decided from lease and heartbeat evidence only", () => {
  assert.equal(purgeBlockedReason({ safeAfter: NOW, renderReservations: [], now: NOW }), null);
  assert.equal(purgeBlockedReason({ safeAfter: NOW + 1, renderReservations: [], now: NOW }), "primary_lease_live");
  assert.equal(purgeBlockedReason({
    safeAfter: NOW, now: NOW, renderReservations: [{ heartbeatAt: iso(-1_000) }],
  }), "render_reservation_live");
  assert.equal(purgeBlockedReason({
    safeAfter: NOW, now: NOW, renderReservations: [{ heartbeatAt: iso(-RENDER_LEASE_GRACE_MS - 1) }],
  }), null);
  assert.equal(purgeBlockedReason({
    safeAfter: NOW, now: NOW, renderReservations: [{ heartbeatAt: "not a date" }],
  }), null, "a malformed reservation must not block deletion forever");
});

// --- route and interface wiring -------------------------------------------

const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};

async function callDelete(root, id, { authenticated = true, origin = "http://local" } = {}) {
  const { DELETE } = await import("../app/api/jobs/[id]/route.js");
  const { createSessionToken } = await import("../lib/auth.mjs");
  const previous = {};
  for (const name of ["JOBS_ROOT", ...Object.keys(AUTH_ENV)]) previous[name] = process.env[name];
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root });
  const headers = { Host: "local", "sec-fetch-site": "same-origin" };
  if (origin) headers.Origin = origin;
  if (authenticated) headers.Cookie = `potongin_session=${createSessionToken(AUTH_ENV, 2_000_000_000)}`;
  try {
    return await DELETE(new Request(`http://local/api/jobs/${id}`, { method: "DELETE", headers }), {
      params: Promise.resolve({ id }),
    });
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("an unauthenticated delete is refused and removes nothing", async (t) => {
  const root = await jobsRoot(t);
  const job = completedJob();
  const jobRoot = await writeJob(root, job);

  const response = await callDelete(root, job.id, { authenticated: false });
  assert.notEqual(response.status, 202);
  assert.ok(response.status === 401 || response.status === 302 || response.status === 403, `unexpected status ${response.status}`);
  assert.equal(await exists(jobRoot), true);
});

test("a cross-origin delete is refused and removes nothing", async (t) => {
  const root = await jobsRoot(t);
  const job = completedJob();
  const jobRoot = await writeJob(root, job);

  const response = await callDelete(root, job.id, { origin: "http://evil.example" });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).code, "csrf_rejected");
  assert.equal(await exists(jobRoot), true);
});

test("an authenticated delete of a finished project removes it within the request", async (t) => {
  const root = await jobsRoot(t);
  const job = completedJob();
  const jobRoot = await writeJob(root, job);

  const response = await callDelete(root, job.id);
  assert.equal(response.status, 202);
  const payload = await response.json();
  assert.equal(payload.removed, true);
  assert.equal(payload.job.status, DELETING_STATUS);
  assert.equal(payload.job.sourcePath, undefined, "the response must not leak server paths");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(await exists(jobRoot), false);
});

test("deleting a running project answers before the bytes are gone", async (t) => {
  const root = await jobsRoot(t);
  const job = runningJob();
  const jobRoot = await writeJob(root, job);

  const response = await callDelete(root, job.id);
  assert.equal(response.status, 202);
  assert.equal((await response.json()).removed, false, "bytes wait for the revoked lease to lapse");
  assert.equal(await exists(jobRoot), true);
  assert.equal(await exists(path.join(root, ".deletions", `${job.id}.json`)), true);
});

test("deleting an unknown project reports 404", async (t) => {
  const root = await jobsRoot(t);
  const response = await callDelete(root, crypto.randomUUID());
  assert.equal(response.status, 404);
});

test("the purge runs from the primary worker poll loop", async () => {
  const source = await readFile(new URL("../scripts/primary-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /purgeDeletedJobs\(jobsRoot\)/);
});

test("the project history offers deletion without a blocking browser dialog", async () => {
  const source = await readFile(new URL("../app/projects/page.jsx", import.meta.url), "utf8");
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /Hapus permanen\?/);
  assert.match(source, /deleting: "Menghapus"/);
  assert.doesNotMatch(source, /(?<![\w.])confirm\(/, "a modal confirm() blocks the page and the extension");
});

test("the retention policy documents the deletion exception and its ordering", async () => {
  const doc = await readFile(new URL("../../docs/operations/STORAGE_RETENTION.md", import.meta.url), "utf8");
  assert.match(doc, /explicit user-initiated deletion/i);
  assert.match(doc, /render reservation records \*\*before\*\* the job directory/);
  // The exception must not soften the rule it sits next to.
  assert.match(doc, /## Retention policy: never delete jobs automatically/);
  assert.match(doc, /or automated retention cron/i);
  assert.match(doc, /must never be automated into one/i);
});

test("the production deploy guard does not treat a pending deletion as live work", async () => {
  // The guard blocks deployment on any status outside its allow-list. A job
  // awaiting purge would otherwise block every deploy until it finished.
  const script = await readFile(new URL("../../deploy/production.sh", import.meta.url), "utf8");
  assert.match(script, /\{"completed", "failed", "deleting"\}/);
});
