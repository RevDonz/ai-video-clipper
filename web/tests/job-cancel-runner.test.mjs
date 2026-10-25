// The runner side of "Batalkan": a revoked lease stops the whole process tree of the job, also a
// descendant that left the group (the engine starts some FFmpeg runs in their own session), and
// a cancelled attempt leaves no partial files behind. These tests start real, harmless processes.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createProcessTree, parseProcStat } from "../lib/process-tree.mjs";
import { LeaseLostError, cancelPrimaryJob, claimNextJob, withPrimaryQueueLock } from "../lib/primary-job-queue.mjs";
import { main, runFencedProcess } from "../scripts/run-job.mjs";

const LINUX = existsSync("/proc/self/stat");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Independent of the module under test: a pid counts as running while its /proc entry exists,
// still has the start time it had when first seen, and is not a zombie.
function identity(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
  return { pid, start: fields[19] };
}
function running({ pid, start }) {
  try {
    const text = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    return fields[19] === start && fields[0] !== "Z" && fields[0] !== "X";
  } catch {
    return false;
  }
}

async function waitFor(check, { timeoutMs = 10_000, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const readJsonFile = async (file) => {
  try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; }
};

async function scratch(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

// Kills whatever a failed test left running, by pid and only while it is still the same process.
function reapAfter(t, processes) {
  t.after(() => {
    for (const proc of processes()) {
      if (proc && running(proc)) {
        try { process.kill(proc.pid, "SIGKILL"); } catch { /* already gone */ }
      }
    }
  });
}

// A stand-in for a job's child: a grandchild in its own session (like the engine's audio
// analysis FFmpeg), and a grandchild in the same group that ignores SIGTERM. The pids file is
// written once both are in place.
const TREE_SCRIPT = `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { once } from "node:events";
const [pidsFile] = process.argv.slice(2);
const keep = "setInterval(() => {}, 1000);";
const session = spawn(process.execPath, ["-e", keep], { detached: true, stdio: "ignore" });
const stubborn = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\\\n"); ' + keep], { stdio: ["ignore", "pipe", "ignore"] });
await once(stubborn.stdout, "data");
writeFileSync(pidsFile, JSON.stringify({ leader: process.pid, session: session.pid, stubborn: stubborn.pid }));
setInterval(() => {}, 1000);
`;

test("parseProcStat reads the fields after the command name, even one with spaces and parentheses", () => {
  const line = "4321 (python3 (x) y) S 4300 4321 4321 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 98765 1000 10";
  assert.deepEqual(parseProcStat(line), { pid: 4321, state: "S", ppid: 4300, pgid: 4321, start: "98765" });
  assert.equal(parseProcStat("garbage"), null);
  assert.equal(parseProcStat(""), null);
});

test("the process tree follows children into other sessions and skips zombies", async (t) => {
  const procRoot = await scratch(t, "potongin-proc-");
  const entry = async (pid, comm, state, ppid, pgid, start) => {
    await mkdir(path.join(procRoot, String(pid)), { recursive: true });
    const tail = ["0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "20", "0", "1", "0", String(start), "0", "0"].join(" ");
    await writeFile(path.join(procRoot, String(pid), "stat"), `${pid} (${comm}) ${state} ${ppid} ${pgid} ${pgid} ${tail}\n`);
  };
  await entry(100, "node", "S", 1, 100, 500);       // the job's child, a group leader
  await entry(101, "python", "S", 100, 100, 501);   // same group
  await entry(102, "ffmpeg", "R", 101, 102, 502);   // its own session
  await entry(103, "ffmpeg", "Z", 101, 101, 503);   // already exited
  await entry(104, "x", "S", 102, 102, 504);        // below the session leader
  await entry(200, "unrelated", "S", 1, 200, 600);
  await mkdir(path.join(procRoot, "self"));
  const tree = createProcessTree({ procRoot });

  const found = tree.descendants(100).sort((a, b) => a.pid - b.pid);
  assert.deepEqual(found, [
    { pid: 101, pgid: 100, start: "501" },
    { pid: 102, pgid: 102, start: "502" },
    { pid: 104, pgid: 102, start: "504" },
  ]);
  assert.equal(tree.alive({ pid: 102, start: "502" }), true);
  assert.equal(tree.alive({ pid: 102, start: "999" }), false, "a reused pid is another process");
  assert.equal(tree.alive({ pid: 103, start: "503" }), false, "a zombie has already exited");
  assert.equal(tree.alive({ pid: 999, start: "1" }), false);
  assert.deepEqual(createProcessTree({ procRoot: path.join(procRoot, "missing") }).descendants(100), []);
});

test("a revoked lease stops the whole tree: the child, a grandchild in its own session and one that ignores SIGTERM", { skip: !LINUX, timeout: 30_000 }, async (t) => {
  const directory = await scratch(t, "potongin-tree-");
  const script = path.join(directory, "tree.mjs");
  const pidsFile = path.join(directory, "pids.json");
  await writeFile(script, TREE_SCRIPT);
  let procs = [];
  reapAfter(t, () => procs);

  let revoked = false;
  const outcome = runFencedProcess({
    command: process.execPath, args: [script, pidsFile], env: process.env, heartbeatMs: 60_000, progress: false,
    update: async () => ({}),
    leaseCheck: async () => !revoked,
    leaseCheckMs: 25,
    escalationMs: 300,
    processTree: createProcessTree(),
  });
  const pids = await waitFor(() => readJsonFile(pidsFile), { what: "the fake tree" });
  procs = Object.values(pids).map(identity);
  for (const proc of procs) assert.equal(running(proc), true);

  revoked = true;
  await assert.rejects(outcome, LeaseLostError);
  const [leader, session, stubborn] = procs;
  assert.equal(running(leader), false, "the child itself");
  assert.equal(running(session), false, "a grandchild that started its own session");
  assert.equal(running(stubborn), false, "a grandchild that ignores SIGTERM after its leader is gone");
});

test("the lease check alone stops a child even when no fenced write happens", { skip: !LINUX, timeout: 30_000 }, async (t) => {
  const directory = await scratch(t, "potongin-tree-");
  const pidsFile = path.join(directory, "pids.json");
  const script = path.join(directory, "sleep.mjs");
  await writeFile(script, `import { writeFileSync } from "node:fs";
writeFileSync(process.argv[2], JSON.stringify({ leader: process.pid }));
setInterval(() => {}, 1000);
`);
  let procs = [];
  reapAfter(t, () => procs);
  let checks = 0;
  const outcome = runFencedProcess({
    command: process.execPath, args: [script, pidsFile], env: process.env, heartbeatMs: 60_000, progress: false,
    update: async () => ({}),
    leaseCheck: async () => {
      if (!existsSync(pidsFile)) return true;
      checks += 1;
      return checks < 3 ? true : checks === 3 ? null : false;
    },
    leaseCheckMs: 25,
  });
  // The 25 ms check can stop the child before waitFor sees its pid file; handle the rejection now.
  const stopped = assert.rejects(outcome, LeaseLostError);
  const pids = await waitFor(() => readJsonFile(pidsFile), { what: "the fake child" });
  // The same race: the child can already be gone, /proc entry and all, by the time its pid is read.
  try {
    procs = [identity(pids.leader)];
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await stopped;
  assert.ok(checks >= 4, "an unreadable state (null) is no verdict; only false stops the child");
  assert.equal(procs.some(running), false);
});

// --- run-job main(): cancelling a running job end to end ------------------------------------------

const LONG_ENGINE = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const output = process.argv[process.argv.indexOf("--output-dir") + 1];
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, "clip-01.partial.mp4"), Buffer.alloc(4096));
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
writeFileSync(process.env.FAKE_PIDS, JSON.stringify({ engine: process.pid, helper: helper.pid }));
console.log('POTONGIN_PROGRESS {"progress":40,"stage":"transcribing","detail":"Transkripsi audio 10%"}');
setInterval(() => {}, 1000);
`;

async function runnerFixture(t) {
  const root = await scratch(t, "potongin-cancel-run-");
  const id = crypto.randomUUID();
  const jobRoot = path.join(root, id);
  await mkdir(path.join(jobRoot, "input"), { recursive: true });
  const sourcePath = path.join(jobRoot, "input", "source.mp4");
  await writeFile(sourcePath, "video");
  await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
    id, status: "queued", progress: 0,
    createdAt: "2026-10-21T00:00:00.000Z", updatedAt: "2026-10-21T00:00:00.000Z",
    source: { type: "upload", name: "source.mp4" }, sourcePath,
    options: { renderMode: "fit-blur", limit: 1, minDuration: 20, maxDuration: 60 },
    clips: [], queue: { version: 1, attempts: 0 },
  }));
  // The jobs root holds job directories only; the stand-ins live next to it.
  const bin = await scratch(t, "potongin-cancel-bin-");
  const engine = path.join(bin, "fake-engine.mjs");
  await writeFile(engine, LONG_ENGINE);
  await chmod(engine, 0o755);
  const pidsFile = path.join(bin, "pids.json");
  const claim = await claimNextJob({ jobsRoot: root, workerId: "worker", leaseMs: 60_000, maxAttempts: 3 });
  assert.ok(claim);
  const env = { ...process.env, JOBS_ROOT: root, PRIMARY_LEASE_MS: "60000", AI_CLIPPER_BIN: engine, FAKE_PIDS: pidsFile };
  const attemptRoot = path.join(jobRoot, ".attempts", crypto.createHash("sha256").update(claim.token).digest("hex"));
  return { root, id, jobRoot, claim, env, pidsFile, attemptRoot, sourcePath };
}

const exists = async (target) => {
  try { await stat(target); return true; } catch { return false; }
};

test("Batalkan on a running job stops the engine and its helpers and removes the attempt's partial files", { skip: !LINUX, timeout: 30_000 }, async (t) => {
  const fixture = await runnerFixture(t);
  let procs = [];
  reapAfter(t, () => procs);
  const exitCode = process.exitCode;

  const run = main(["node", "run-job.mjs", fixture.id, fixture.claim.token], fixture.env);
  const pids = await waitFor(() => readJsonFile(fixture.pidsFile), { what: "the fake engine" });
  procs = [identity(pids.engine), identity(pids.helper)];
  await waitFor(() => exists(path.join(fixture.attemptRoot, "output", "clip-01.partial.mp4")), { what: "partial output" });

  const cancelled = await cancelPrimaryJob({ jobsRoot: fixture.root, id: fixture.id });
  assert.equal(cancelled.outcome, "cancelled");
  await run;

  for (const proc of procs) assert.equal(running(proc), false, `pid ${proc.pid} must not outlive the cancel`);
  assert.equal(await exists(fixture.attemptRoot), false, "the cancelled attempt's partial files are removed");
  assert.equal(await exists(fixture.sourcePath), true, "the uploaded source stays with the project");
  const job = JSON.parse(await readFile(path.join(fixture.jobRoot, "job.json"), "utf8"));
  assert.equal(job.status, "cancelled");
  assert.equal(job.error, null);
  assert.equal(process.exitCode, exitCode, "a cancel is not a runner failure");
});

test("a lease lost to another worker still fails the runner and keeps the attempt's files", { skip: !LINUX, timeout: 30_000 }, async (t) => {
  const fixture = await runnerFixture(t);
  let procs = [];
  reapAfter(t, () => procs);

  const run = main(["node", "run-job.mjs", fixture.id, fixture.claim.token], fixture.env);
  const pids = await waitFor(() => readJsonFile(fixture.pidsFile), { what: "the fake engine" });
  procs = [identity(pids.engine), identity(pids.helper)];

  // Another worker took the job over: same status, someone else's lease. A real takeover holds
  // the queue lock (claimNextJob); without it the runner's progress write, which read the job
  // before this rename, could put its own lease back after it and the engine would never stop.
  const jobPath = path.join(fixture.jobRoot, "job.json");
  await withPrimaryQueueLock(fixture.root, async () => {
    const current = JSON.parse(await readFile(jobPath, "utf8"));
    current.queue.lease = { ...current.queue.lease, tokenHash: "d".repeat(64), owner: "worker-b" };
    await writeFile(`${jobPath}.tmp`, JSON.stringify(current));
    await rename(`${jobPath}.tmp`, jobPath);
  });

  await assert.rejects(run, LeaseLostError);
  for (const proc of procs) assert.equal(running(proc), false, `pid ${proc.pid}`);
  assert.equal(await exists(fixture.attemptRoot), true, "retention keeps the work of an attempt nobody cancelled");
  assert.equal(JSON.parse(await readFile(jobPath, "utf8")).status, "processing");
});

test("the retention policy documents what Batalkan removes and what it keeps", async () => {
  const doc = await readFile(new URL("../../docs/operations/STORAGE_RETENTION.md", import.meta.url), "utf8");
  assert.match(doc, /## Cancelling a job/);
  assert.match(doc, /\.attempts\/<attempt>/);
  assert.match(doc, /POST \/api\/jobs\/<id>\/cancel/);
});
