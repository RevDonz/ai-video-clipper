import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { claimNextJob } from "../lib/primary-job-queue.mjs";
import { checkPrimaryWorkerHealth } from "../scripts/check-primary-worker-health.mjs";
import { runClaim } from "../scripts/primary-worker.mjs";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

async function fixture() {
  const jobsRoot = await mkdtemp(path.join(os.tmpdir(), "primary-worker-"));
  const jobRoot = path.join(jobsRoot, id);
  await mkdir(path.join(jobRoot, "input"), { recursive: true });
  await writeFile(path.join(jobRoot, "input", "source.mp4"), "video");
  await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
    id, status: "queued", progress: 0,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    source: { type: "upload", name: "source.mp4" },
    sourcePath: path.join(jobRoot, "input", "source.mp4"),
    options: { renderMode: "fit-blur", limit: 1, minDuration: 20, maxDuration: 60 }, clips: [],
  }));
  const claim = await claimNextJob({ jobsRoot, workerId: "worker", leaseMs: 60_000, maxAttempts: 3 });
  return { jobsRoot, jobRoot, claim };
}

test("primary watcher starts fenced runner with argv only and persists spawn errors", async () => {
  const { jobsRoot, jobRoot, claim } = await fixture();
  let invocation;
  const spawnImpl = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("error", new Error("spawn EACCES")));
    return child;
  };
  await assert.rejects(
    runClaim({ claim, jobsRoot, leaseMs: 60_000, env: { JOBS_ROOT: jobsRoot }, spawnImpl, runner: "/web/scripts/run-job.mjs" }),
    /spawn EACCES/,
  );
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, ["/web/scripts/run-job.mjs", id, claim.token]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.detached, false);
  const state = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  assert.equal(state.status, "failed");
  assert.match(state.error, /spawn EACCES/);
  assert.doesNotMatch(state.error, /\/web\/scripts/);
});

test("primary watcher validates claim identity before opening worker log", async () => {
  const { jobsRoot, jobRoot, claim } = await fixture();
  claim.job.id = "../outside";
  await assert.rejects(runClaim({ claim, jobsRoot, leaseMs: 60_000, spawnImpl: () => { throw new Error("must not spawn"); } }), /job|identity|uuid/i);
  await assert.rejects(readFile(path.join(jobRoot, "worker.log")), { code: "ENOENT" });
});

test("primary watcher rejects symlinked uploaded source before logging or spawning", async () => {
  const { jobsRoot, jobRoot, claim } = await fixture();
  await rm(path.join(jobRoot, "input", "source.mp4"));
  await symlink("/etc/passwd", path.join(jobRoot, "input", "source.mp4"));
  await assert.rejects(runClaim({ claim, jobsRoot, leaseMs: 60_000, spawnImpl: () => { throw new Error("must not spawn"); } }), /source|symlink|safe/i);
  await assert.rejects(readFile(path.join(jobRoot, "worker.log")), { code: "ENOENT" });
});

test("primary healthcheck requires fresh polling when idle but permits an active claim", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "primary-health-"));
  const healthPath = path.join(root, "health.json");
  const now = Date.parse("2026-01-01T00:01:00.000Z");
  const base = { version: 1, pid: process.pid, workerId: "worker", heartbeatAt: new Date(now).toISOString(), lastPollAt: new Date(now - 20_000).toISOString() };
  await writeFile(healthPath, JSON.stringify({ ...base, activeClaims: 0 }));
  await assert.rejects(checkPrimaryWorkerHealth({ PRIMARY_WORKER_HEALTH_PATH: healthPath, PRIMARY_WORKER_HEALTH_MAX_AGE_MS: "15000" }, now), /polling.*stale/i);
  await writeFile(healthPath, JSON.stringify({ ...base, activeClaims: 1 }));
  assert.equal((await checkPrimaryWorkerHealth({ PRIMARY_WORKER_HEALTH_PATH: healthPath, PRIMARY_WORKER_HEALTH_MAX_AGE_MS: "15000" }, now)).activeClaims, 1);
  await writeFile(healthPath, JSON.stringify({ ...base, activeClaims: 1, heartbeatAt: new Date(now - 20_000).toISOString() }));
  await assert.rejects(checkPrimaryWorkerHealth({ PRIMARY_WORKER_HEALTH_PATH: healthPath, PRIMARY_WORKER_HEALTH_MAX_AGE_MS: "15000" }, now), /heartbeat.*stale/i);
});
