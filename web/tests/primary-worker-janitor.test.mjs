// T4.3: the editor janitor runs from the primary worker between jobs (plan §11.4), never while a
// job is active, and jobs wait while it runs.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PYTHON_CLI_MODULES } from "../lib/python-cli.mjs";
import { checkPrimaryWorkerHealth } from "../scripts/check-primary-worker-health.mjs";
import {
  DEFAULT_JANITOR_INTERVAL_MS,
  JANITOR_MODULE,
  createJanitorTick,
  createWorkerActivity,
  primaryHealthSnapshot,
} from "../scripts/primary-worker.mjs";

function clock(start = 1_790_000_000_000) {
  let at = start;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

function recorder(results) {
  const calls = [];
  const queue = [...results];
  const runCli = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    const next = queue.shift() ?? { exitCode: 0, json: { complete: true, next: null } };
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, runCli };
}

test("the janitor module is one of the CLIs python-cli may start", () => {
  assert.equal(JANITOR_MODULE, "ai_clipper.edit_v2.janitor");
  assert.ok(PYTHON_CLI_MODULES.includes(JANITOR_MODULE));
});

test("an idle worker runs the janitor once per interval with the job root's settings", async () => {
  const time = clock();
  const { calls, runCli } = recorder([]);
  const janitor = createJanitorTick({
    env: { JOBS_ROOT: "/data/jobs", POTONGIN_PREVIEW_CACHE_BYTES: "536870912" },
    now: time.now, runCli, log: () => {},
  });
  assert.equal(await janitor.maybeRun(() => true), true);
  assert.equal(calls.length, 1);
  const [{ module, op, payload, options }] = calls;
  assert.equal(module, JANITOR_MODULE);
  assert.equal(op, "run");
  assert.deepEqual(Object.keys(payload).sort(), ["budgetMs", "capBytes", "nowMs"]);
  assert.equal(payload.nowMs, time.now());
  assert.equal(payload.capBytes, 536870912);
  assert.ok(options.timeoutMs > payload.budgetMs);
  assert.equal(options.env.JOBS_ROOT, "/data/jobs");
  assert.equal(await janitor.maybeRun(() => true), false); // not due yet
  time.advance(DEFAULT_JANITOR_INTERVAL_MS);
  assert.equal(await janitor.maybeRun(() => true), true);
  assert.equal(calls.length, 2);
});

test("the janitor never runs while a job is active or being claimed", async () => {
  const { calls, runCli } = recorder([]);
  const activity = createWorkerActivity();
  const janitor = createJanitorTick({ env: {}, now: clock().now, runCli, log: () => {} });
  activity.claiming();
  assert.equal(await janitor.maybeRun(activity.idle), false);
  activity.claimed(true);
  assert.equal(await janitor.maybeRun(activity.idle), false);
  activity.finished();
  assert.equal(await janitor.maybeRun(activity.idle), true);
  activity.claiming();
  activity.claimed(false); // nothing to claim: still idle
  assert.equal(activity.idle(), true);
  assert.equal(calls.length, 1);
});

test("claims wait while the janitor runs", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const runCli = async () => { await gate; return { exitCode: 0, json: { complete: true, next: null } }; };
  const activity = createWorkerActivity();
  const janitor = createJanitorTick({ env: {}, now: clock().now, runCli, log: () => {} });
  const running = janitor.maybeRun(activity.idle);
  assert.equal(janitor.running, true);
  assert.equal(activity.mayClaim(janitor), false);
  release();
  await running;
  assert.equal(janitor.running, false);
  assert.equal(activity.mayClaim(janitor), true);
});

test("an unfinished run continues from its cursor at the next idle poll", async () => {
  const time = clock();
  const cursor = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const { calls, runCli } = recorder([
    { exitCode: 0, json: { complete: false, next: cursor } },
    { exitCode: 0, json: { complete: true, next: null } },
  ]);
  const janitor = createJanitorTick({ env: {}, now: time.now, runCli, log: () => {} });
  await janitor.maybeRun(() => true);
  time.advance(1);
  assert.equal(await janitor.maybeRun(() => true), true);
  assert.equal(calls[1].payload.after, cursor);
  assert.equal(await janitor.maybeRun(() => true), false); // done: wait for the interval
});

test("a failing janitor is logged without detail and retried after the interval", async () => {
  const time = clock();
  const lines = [];
  const error = new Error("/data/jobs/secret-path exploded");
  const { calls, runCli } = recorder([error, { exitCode: 1, json: { error: { code: "internal_error" } } }]);
  const janitor = createJanitorTick({ env: {}, now: time.now, runCli, log: (line) => lines.push(line) });
  assert.equal(await janitor.maybeRun(() => true), true);
  assert.equal(janitor.running, false);
  assert.equal(await janitor.maybeRun(() => true), false);
  time.advance(DEFAULT_JANITOR_INTERVAL_MS);
  assert.equal(await janitor.maybeRun(() => true), true);
  assert.equal(calls.length, 2);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.doesNotMatch(line, /secret-path|\/data/);
});

test("a janitor run counts as active work for the health check", async () => {
  // The health check wants fresh polling while no claim is active; a janitor run (up to its
  // budget) stops slot 0 from polling, so the snapshot counts it as active work.
  const now = Date.parse("2026-10-02T01:00:00.000Z");
  const base = { pid: process.pid, workerId: "worker", heartbeatAt: new Date(now).toISOString(),
    lastPollAt: new Date(now - 60_000).toISOString() };
  const idle = primaryHealthSnapshot({ ...base, activeClaims: 0, janitorRunning: false });
  const cleaning = primaryHealthSnapshot({ ...base, activeClaims: 0, janitorRunning: true });
  assert.equal(idle.activeClaims, 0);
  assert.equal(cleaning.activeClaims, 1);
  assert.equal(cleaning.janitor, true);
  const root = await mkdtemp(path.join(os.tmpdir(), "primary-janitor-health-"));
  const healthPath = path.join(root, "health.json");
  const env = { PRIMARY_WORKER_HEALTH_PATH: healthPath, PRIMARY_WORKER_HEALTH_MAX_AGE_MS: "15000" };
  await writeFile(healthPath, JSON.stringify(idle));
  await assert.rejects(checkPrimaryWorkerHealth(env, now), /polling.*stale/i);
  await writeFile(healthPath, JSON.stringify(cleaning));
  assert.equal((await checkPrimaryWorkerHealth(env, now)).activeClaims, 1);
});

test("an invalid cache cap falls back to the default", async () => {
  const { calls, runCli } = recorder([]);
  const janitor = createJanitorTick({ env: { POTONGIN_PREVIEW_CACHE_BYTES: "lots" }, now: clock().now, runCli, log: () => {} });
  await janitor.maybeRun(() => true);
  assert.equal("capBytes" in calls[0].payload, false);
});
