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
import { runPythonCli } from "../lib/python-cli.mjs";

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

// The editor janitor (plan §4.4, §11.4 T4.3; `ai_clipper.edit_v2.janitor`): receipts, archives,
// suggestions, preview caches and orphan assets. Slot 0 runs it between jobs, at most once per
// interval, never while a job is active or being claimed, and no slot claims while it runs. A run
// has a time budget; an unfinished one continues from its cursor at the next idle poll.
export const JANITOR_MODULE = "ai_clipper.edit_v2.janitor";
export const DEFAULT_JANITOR_INTERVAL_MS = 6 * 60 * 60_000;
export const JANITOR_BUDGET_MS = 60_000;
const JANITOR_TIMEOUT_MS = JANITOR_BUDGET_MS + 60_000;

export function createWorkerActivity() {
  let claims = 0;
  let active = 0;
  return {
    claiming() { claims += 1; },
    claimed(gotJob) { claims -= 1; if (gotJob) active += 1; },
    finished() { active -= 1; },
    idle: () => claims === 0 && active === 0,
    mayClaim: (janitor) => !janitor?.running,
  };
}

export function createJanitorTick({
  env = process.env,
  intervalMs = DEFAULT_JANITOR_INTERVAL_MS,
  now = Date.now,
  runCli = runPythonCli,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  let nextAt = now();
  let cursor = null;
  let running = false;
  const cap = Number(env.POTONGIN_PREVIEW_CACHE_BYTES);
  return {
    get running() { return running; },
    async maybeRun(isIdle) {
      if (running || now() < nextAt || !isIdle()) return false;
      running = true; // set before any await: the slots see it at once
      try {
        const payload = { nowMs: now(), budgetMs: JANITOR_BUDGET_MS };
        if (Number.isSafeInteger(cap) && cap > 0) payload.capBytes = cap;
        if (cursor) payload.after = cursor;
        const result = await runCli(JANITOR_MODULE, "run", payload, { timeoutMs: JANITOR_TIMEOUT_MS, env });
        const report = result?.exitCode === 0 ? result.json : null;
        if (report && report.complete === false && typeof report.next === "string") {
          cursor = report.next;
          nextAt = now();
        } else {
          if (!report) log("Editor janitor failed");
          cursor = null;
          nextAt = now() + intervalMs;
        }
      } catch {
        log("Editor janitor failed");
        cursor = null;
        nextAt = now() + intervalMs;
      } finally {
        running = false;
      }
      return true;
    },
  };
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

  const activity = createWorkerActivity();
  const janitor = createJanitorTick({ env: { ...env, JOBS_ROOT: jobsRoot } });

  async function slot(index) {
    while (!stopping) {
      if (!activity.mayClaim(janitor)) {
        await sleep(pollMs);
        continue;
      }
      activity.claiming();
      let claim = null;
      try {
        claim = await claimNextJob({
          jobsRoot,
          workerId: `${workerId}:${index}`,
          leaseMs: config.leaseMs,
          maxAttempts: config.maxAttempts,
          legacyQuiescenceMs: config.legacyQuiescenceMs,
        });
      } finally {
        activity.claimed(Boolean(claim));
      }
      lastPollAt = new Date().toISOString();
      await writeHealth();
      if (!claim) {
        // One slot drives the deletion purge: jobs whose lease was revoked
        // become removable once that lease window has passed. The same slot runs
        // the editor janitor when no job is active.
        if (index === 0) {
          await purgeDeletedJobs(jobsRoot).catch((error) => {
            process.stderr.write(`${safeWorkerError(error, "Job purge failed")}\n`);
          });
          if (!stopping) await janitor.maybeRun(activity.idle);
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
        activity.finished();
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
