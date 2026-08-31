import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { closeSync, constants, openSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  LeaseLostError,
  claimNextJob,
  failClaimedJob,
  parsePrimaryQueueConfig,
  validateClaimForExecution,
} from "../lib/primary-job-queue.mjs";
import { purgeDeletedJobs } from "../lib/job-deletion.mjs";

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function safeWorkerError(error, fallback) {
  const message = typeof error?.message === "string" ? error.message : fallback;
  return message.slice(0, 500);
}

export async function runClaim({
  claim,
  jobsRoot,
  leaseMs,
  env = process.env,
  spawnImpl = spawn,
  runner = path.join(process.cwd(), "scripts", "run-job.mjs"),
}) {
  const validated = await validateClaimForExecution({ jobsRoot, claim });
  const logFd = openSync(path.join(validated.jobRoot, "worker.log"), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      let child;
      try {
        child = spawnImpl(process.execPath, [runner, claim.job.id, claim.token], {
          detached: false,
          shell: false,
          stdio: ["ignore", logFd, logFd],
          env: { ...env, JOBS_ROOT: jobsRoot, PRIMARY_LEASE_MS: String(leaseMs) },
        });
      } catch (error) {
        reject(error);
        return;
      }
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        if (code === 0) resolve();
        else reject(new Error(`Primary runner stopped (${signal || `exit ${code}`})`));
      });
    });
  } catch (error) {
    try {
      await failClaimedJob({
        jobsRoot,
        id: claim.job.id,
        token: claim.token,
        leaseMs,
        error: safeWorkerError(error, "Primary runner failed"),
      });
    } catch (persistError) {
      if (!(persistError instanceof LeaseLostError)) throw new AggregateError([error, persistError], "Primary runner failed and its state could not be persisted");
    }
    throw error;
  } finally {
    closeSync(logFd);
  }
}

export async function main(env = process.env) {
  const config = parsePrimaryQueueConfig(env);
  const jobsRoot = path.resolve(env.JOBS_ROOT || "/data/jobs");
  const pollMs = env.PRIMARY_WORKER_POLL_MS === undefined ? 2_000 : Number(env.PRIMARY_WORKER_POLL_MS);
  if (!Number.isSafeInteger(pollMs) || pollMs < 100 || pollMs > 60_000) {
    throw new Error("Invalid primary queue configuration: PRIMARY_WORKER_POLL_MS");
  }
  const workerId = `${os.hostname()}:${process.pid}`;
  const healthPath = path.resolve(env.PRIMARY_WORKER_HEALTH_PATH || "/tmp/primary-worker-health.json");
  let activeClaims = 0;
  let lastPollAt = new Date().toISOString();
  let healthWriteQueue = Promise.resolve();
  const writeHealth = () => {
    const snapshot = { version: 1, pid: process.pid, workerId, heartbeatAt: new Date().toISOString(), lastPollAt, activeClaims };
    const publish = async () => {
      const pending = `${healthPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const fd = await open(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await fd.writeFile(`${JSON.stringify(snapshot)}\n`);
        await fd.sync();
      } finally { await fd.close(); }
      try { await rename(pending, healthPath); }
      catch (error) { await rm(pending, { force: true }); throw error; }
    };
    healthWriteQueue = healthWriteQueue.then(publish, publish);
    return healthWriteQueue;
  };
  await writeHealth();
  const healthTimer = setInterval(() => { writeHealth().catch((error) => process.stderr.write(`${safeWorkerError(error, "Primary health heartbeat failed")}\n`)); }, Math.min(5_000, pollMs));
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });

  async function slot(index) {
    while (!stopping) {
      const claim = await claimNextJob({
        jobsRoot,
        workerId: `${workerId}:${index}`,
        leaseMs: config.leaseMs,
        maxAttempts: config.maxAttempts,
        legacyQuiescenceMs: config.legacyQuiescenceMs,
      });
      lastPollAt = new Date().toISOString();
      await writeHealth();
      if (!claim) {
        // One slot drives the deletion purge: jobs whose lease was revoked
        // become removable once that lease window has passed.
        if (index === 0) {
          await purgeDeletedJobs(jobsRoot).catch((error) => {
            process.stderr.write(`${safeWorkerError(error, "Job purge failed")}\n`);
          });
        }
        await sleep(pollMs);
        continue;
      }
      activeClaims += 1;
      try {
        await runClaim({ claim, jobsRoot, leaseMs: config.leaseMs, env });
      } catch (error) {
        process.stderr.write(`${safeWorkerError(error, "Primary runner failed")}\n`);
      } finally {
        activeClaims -= 1;
        lastPollAt = new Date().toISOString();
        await writeHealth();
      }
    }
  }

  try { await Promise.all(Array.from({ length: config.concurrency }, (_, index) => slot(index))); }
  finally { clearInterval(healthTimer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
