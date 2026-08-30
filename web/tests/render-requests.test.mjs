import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  RenderQueueConflictError,
  RenderQueueInvalidError,
  RenderStorageError,
  createRenderRequest,
  runRenderQueuePython,
  sanitizeRenderStatus,
  validateRenderRequest,
} from "../lib/render-requests.mjs";
import {
  bindRenderStorage,
  reserveRenderStorage,
  releaseRenderStorage,
  heartbeatRenderStorage,
} from "../lib/render-storage-admission.mjs";
import {
  PayloadTooLargeError,
  parseRenderBody,
  readBoundedJsonBytes,
} from "../app/api/jobs/[id]/candidates/[candidateId]/renders/route.js";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const CANDIDATE = `cand_${"a".repeat(64)}`;
const SHA = "a".repeat(64);
const request = {
  version: "render-request-v1", render_id: ID, idempotency_key: ID,
  state: "completed", candidate_id: CANDIDATE,
  candidate_artifact_sha256: SHA,
  candidate_snapshot_relative: `analysis/render-inputs/candidates.${SHA}.json`,
  edit_manifest_sha256: SHA, edit_revision: 2,
  edit_manifest_relative: `analysis/edits/archive/${CANDIDATE}.edit.v1.r2.${SHA}.json`,
  source_identity_sha256: SHA, source_content_sha256: SHA,
  source_snapshot_relative: `analysis/render-inputs/source.${SHA}.mp4`,
  output_relative: `output/edits/${CANDIDATE}/revision-2.mp4`,
  created_at: "2026-08-30T00:00:00.000Z", updated_at: "2026-08-30T00:00:01.000Z",
  claimed_at: "2026-08-30T00:00:00.100Z", rendering_at: "2026-08-30T00:00:00.200Z",
  completed_at: "2026-08-30T00:00:01.000Z", failed_at: null,
  attempts: 1, error_code: null, lease_token: null, heartbeat_at: null,
};

test("Python queue bridge uses argv/stdin without shell and maps conflict", async () => {
  let call;
  const result = await runRenderQueuePython("/safe/job", { operation: "get", renderId: ID }, {
    pythonBin: "/venv/python",
    execFileImpl: (bin, argv, options, callback) => {
      call = { bin, argv, options };
      callback(null, Buffer.from(JSON.stringify(request)), Buffer.alloc(0));
      return { stdin: { on() {}, end(value) { call.stdin = value; } } };
    },
  });
  assert.deepEqual(call.argv, ["-m", "ai_clipper.render_queue", "--job-dir", "/safe/job"]);
  assert.equal(call.options.shell, false);
  assert.deepEqual(JSON.parse(call.stdin), { operation: "get", renderId: ID });
  assert.equal(result.render_id, ID);

  await assert.rejects(runRenderQueuePython("/safe/job", { operation: "get", renderId: ID }, {
    execFileImpl: (_b, _a, _o, callback) => {
      callback(Object.assign(new Error("secret"), { code: 5 }), Buffer.alloc(0), Buffer.from("secret"));
      return { stdin: { on() {}, end() {} } };
    },
  }), RenderQueueConflictError);
});

test("idempotent render replay releases only its unused new reservation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-idempotent-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const job = path.join(root, ID);
  await mkdir(job);
  await writeFile(path.join(job, "job.json"), "{}");
  const newReservationId = "223e4567-e89b-42d3-a456-426614174000";
  const existing = {
    ...request,
    version: "render-request-v2",
    storage_reservation_id: ID,
    storage_reservation_token: ID,
    storage_reserved_bytes: 100,
  };
  const released = [];
  let bound = false;
  const result = await createRenderRequest(ID, CANDIDATE, SHA, ID, root, {
    storageConfig: {}, estimator: async () => 10n,
    randomUUID: () => newReservationId,
    reserve: async () => ({ reservationId: newReservationId, token: newReservationId, reservedBytes: "100" }),
    runner: async () => existing,
    release: async (...args) => { released.push(args); return true; },
    bind: async () => { bound = true; return false; },
  });
  assert.equal(result, existing);
  assert.equal(bound, false);
  assert.deepEqual(released, [[root, newReservationId, newReservationId, "failed"]]);
});

test("public render status never exposes filesystem paths or source hashes", () => {
  const safe = sanitizeRenderStatus("job-id", request);
  assert.deepEqual(safe, {
    renderId: ID, candidateId: CANDIDATE, state: "completed", revision: 2, attempts: 1,
    createdAt: request.created_at, updatedAt: request.updated_at, errorCode: null,
    resultUrl: `/api/jobs/job-id/files/output/edits/${CANDIDATE}/revision-2.mp4`,
  });
  assert.doesNotMatch(JSON.stringify(safe), /sha256|source|analysis\/|\/safe/);
});

test("render request schema requires exactly the 24 authoritative fields", () => {
  assert.equal(Object.keys(validateRenderRequest({ ...request })).length, 24);
  for (const forged of [
    { ...request, extra: true },
    Object.fromEntries(Object.entries(request).filter(([key]) => key !== "heartbeat_at")),
    { ...request, output_relative: `output/edits/${CANDIDATE}/../revision-2.mp4` },
    { ...request, candidate_snapshot_relative: "analysis/render-inputs/candidates.fake.json" },
    { ...request, source_snapshot_relative: `analysis/render-inputs/../source.${SHA}.mp4` },
    { ...request, edit_manifest_relative: `analysis/edits/archive/${CANDIDATE}.edit.v1.r3.${SHA}.json` },
  ]) assert.throws(() => validateRenderRequest(forged), RenderQueueInvalidError);
});

test("render request schema rejects invalid scalar types and formats", () => {
  for (const forged of [
    { ...request, render_id: ID.toUpperCase() },
    { ...request, candidate_artifact_sha256: "A".repeat(64) },
    { ...request, source_content_sha256: "0".repeat(63) },
    { ...request, created_at: "2026-08-30T00:00:00Z" },
    { ...request, updated_at: "2026-02-30T00:00:00.000Z" },
    { ...request, completed_at: 1 },
    { ...request, edit_revision: true },
    { ...request, edit_revision: 0 },
    { ...request, attempts: true },
    { ...request, attempts: 4 },
    { ...request, error_code: "secret_internal_error" },
  ]) assert.throws(() => validateRenderRequest(forged), RenderQueueInvalidError);
});

test("render request schema enforces every state combination", () => {
  const queued = {
    ...request, state: "queued", attempts: 0, claimed_at: null, rendering_at: null,
    completed_at: null, failed_at: null, lease_token: null, heartbeat_at: null,
  };
  assert.equal(validateRenderRequest(queued).state, "queued");
  const claimed = {
    ...queued, state: "claimed", attempts: 1, claimed_at: request.claimed_at,
    lease_token: ID, heartbeat_at: request.claimed_at,
  };
  assert.equal(validateRenderRequest(claimed).state, "claimed");
  const rendering = { ...claimed, state: "rendering", rendering_at: request.rendering_at };
  assert.equal(validateRenderRequest(rendering).state, "rendering");
  const failed = {
    ...claimed, state: "failed", lease_token: null, heartbeat_at: null,
    failed_at: request.completed_at, error_code: "render_failed",
  };
  assert.equal(validateRenderRequest(failed).state, "failed");

  for (const forged of [
    { ...queued, lease_token: ID },
    { ...claimed, claimed_at: null },
    { ...claimed, rendering_at: request.rendering_at },
    { ...rendering, heartbeat_at: null },
    { ...request, completed_at: null },
    { ...request, failed_at: request.completed_at },
    { ...failed, error_code: null },
    { ...failed, completed_at: request.completed_at },
  ]) assert.throws(() => validateRenderRequest(forged), RenderQueueInvalidError);
});

test("sanitizer validates first and encodes every URL segment", () => {
  assert.throws(() => sanitizeRenderStatus("job/id", { ...request, extra: true }), RenderQueueInvalidError);
  assert.equal(
    sanitizeRenderStatus("job/id", request).resultUrl,
    `/api/jobs/job%2Fid/files/output/edits/${CANDIDATE}/revision-2.mp4`,
  );
});

test("render body reader accepts many streamed chunks despite a lying short length", async () => {
  const raw = Buffer.from(JSON.stringify({ editEtag: SHA }));
  let offset = 0;
  const request = {
    bodyUsed: false,
    headers: new Headers({ "content-length": "1", "content-type": "application/json" }),
    body: {
      getReader() {
        return {
          async read() {
            if (offset === raw.length) return { done: true };
            return { done: false, value: raw.subarray(offset, ++offset) };
          },
          async cancel() { assert.fail("bounded input must not be cancelled"); },
          releaseLock() {},
        };
      },
    },
  };
  assert.deepEqual(Buffer.from(await readBoundedJsonBytes(request)), raw);

  const parseRequest = new Request("http://local", {
    method: "POST", body: raw, duplex: "half", headers: { "content-type": "application/json" },
  });
  assert.deepEqual(await parseRenderBody(parseRequest), { editEtag: SHA });
});

test("render body reader rejects oversized streams early and cancels the reader", async () => {
  let reads = 0;
  let cancelled = false;
  const request = {
    bodyUsed: false,
    headers: new Headers({ "content-length": "2" }),
    body: {
      getReader() {
        return {
          async read() { reads += 1; return { done: false, value: new Uint8Array(400) }; },
          async cancel() { cancelled = true; },
          releaseLock() {},
        };
      },
    },
  };
  await assert.rejects(readBoundedJsonBytes(request), PayloadTooLargeError);
  assert.equal(reads, 3);
  assert.equal(cancelled, true);

  await assert.rejects(readBoundedJsonBytes({
    bodyUsed: false,
    headers: new Headers({ "content-length": "1025" }),
    body: { getReader() { assert.fail("known oversized body must be rejected before reading"); } },
  }), PayloadTooLargeError);
});

test("render body parser rejects null, consumed, aborted, malformed UTF-8, and extra keys", async () => {
  let abortedReads = 0;
  await assert.rejects(readBoundedJsonBytes({
    bodyUsed: false, signal: { aborted: true }, headers: new Headers(),
    body: { getReader: () => ({
      read: async () => { abortedReads += 1; return { done: true }; },
      cancel: async () => {}, releaseLock() {},
    }) },
  }), RenderQueueInvalidError);
  assert.equal(abortedReads, 0);

  for (const invalid of [
    { bodyUsed: false, body: null, headers: new Headers() },
    { bodyUsed: true, body: {}, headers: new Headers() },
    {
      bodyUsed: false, headers: new Headers(), body: { getReader: () => ({
        read: async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }); },
        cancel: async () => {}, releaseLock() {},
      }) },
    },
  ]) await assert.rejects(readBoundedJsonBytes(invalid), RenderQueueInvalidError);

  for (const raw of [
    Uint8Array.from([0xc3, 0x28]),
    Buffer.from(JSON.stringify({ editEtag: SHA, extra: true })),
    Buffer.from(`{"editEtag":"${SHA}","editEtag":"${SHA}"}`),
  ]) {
    const invalid = new Request("http://local", {
      method: "POST", body: raw, duplex: "half", headers: { "content-type": "application/json" },
    });
    await assert.rejects(parseRenderBody(invalid), RenderQueueInvalidError);
  }
});

test("render reservations serialize admission and fence heartbeat and release", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    quotaBytes: 150n, minimumFreeBytes: 0n, activeReserveBytes: 50n,
    scanMaxEntries: 100, scanMaxDepth: 10, scanDeadlineMs: 1000,
    recheckBytes: 10, recheckIntervalMs: 10,
  };
  const storageOps = { scan: async () => ({ allocatedBytes: 0n }), available: async () => 1000n };
  const first = await reserveRenderStorage(root, {
    reservationId: ID, jobId: ID, declaredBytes: 50n, storageConfig: config, storageOps,
  });
  assert.equal(first.reservedBytes, "100");
  await assert.rejects(reserveRenderStorage(root, {
    reservationId: "223e4567-e89b-42d3-a456-426614174000", jobId: ID,
    declaredBytes: 1n, storageConfig: config, storageOps,
  }), (error) => error.code === "storage_quota_exhausted" && error.status === 507);
  assert.equal(await heartbeatRenderStorage(root, ID, "wrong", config, storageOps), false);
  assert.equal(await heartbeatRenderStorage(root, ID, first.token, config, storageOps), true);
  assert.equal(await releaseRenderStorage(root, ID, "wrong", "failed"), false);
  assert.equal(await releaseRenderStorage(root, ID, first.token, "completed"), true);
  assert.equal(await readFile(path.join(root, ".render-reservations", `${ID}.json`), "utf8").catch((e) => e.code), "ENOENT");
});

test("render reservation restart recovery reaps abandoned admission", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ".render-reservations");
  await mkdir(directory);
  await writeFile(path.join(directory, `${ID}.json`), JSON.stringify({
    version: 1, reservationId: ID, jobId: ID, renderId: null, state: "admitting",
    tokenHash: "0".repeat(64), declaredBytes: "10", workReserveBytes: "20",
    createdAt: "2020-01-01T00:00:00.000Z", heartbeatAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-01T00:00:00.000Z",
  }));
  const config = {
    quotaBytes: 100n, minimumFreeBytes: 0n, activeReserveBytes: 20n,
    scanMaxEntries: 100, scanMaxDepth: 10, scanDeadlineMs: 1000,
    recheckBytes: 10, recheckIntervalMs: 10,
  };
  const storageOps = { scan: async () => ({ allocatedBytes: 0n }), available: async () => 1000n };
  const recovered = await reserveRenderStorage(root, {
    reservationId: "223e4567-e89b-42d3-a456-426614174000", jobId: ID,
    declaredBytes: 10n, storageConfig: config, storageOps, now: Date.parse("2026-01-01T00:00:00Z"),
  });
  assert.ok(recovered.token);
});

test("render reservation restart recovery reaps terminal bound work", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-terminal-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    quotaBytes: 1000n, minimumFreeBytes: 0n, activeReserveBytes: 20n,
    scanMaxEntries: 100, scanMaxDepth: 10, scanDeadlineMs: 1000,
    recheckBytes: 10, recheckIntervalMs: 10,
  };
  const storageOps = { scan: async () => ({ allocatedBytes: 0n }), available: async () => 1000n };
  const reservation = await reserveRenderStorage(root, {
    reservationId: ID, jobId: ID, declaredBytes: 10n, storageConfig: config, storageOps,
  });
  const renderId = "323e4567-e89b-42d3-a456-426614174000";
  assert.equal(await bindRenderStorage(root, ID, reservation.token, renderId), true);
  const requests = path.join(root, ID, "analysis", "render-requests");
  await mkdir(requests, { recursive: true });
  await writeFile(path.join(requests, `${renderId}.json`), JSON.stringify({
    version: "render-request-v2", render_id: renderId, state: "completed",
    storage_reservation_id: ID, storage_reservation_token: reservation.token,
  }));
  await reserveRenderStorage(root, {
    reservationId: "223e4567-e89b-42d3-a456-426614174000", jobId: ID,
    declaredBytes: 10n, storageConfig: config, storageOps,
  });
  assert.equal(await readFile(path.join(root, ".render-reservations", `${ID}.json`), "utf8").catch((e) => e.code), "ENOENT");
});

test("render worker storage CLI uses bounded stdin and sanitized output", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "render-storage-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    quotaBytes: 1_000_000_000n, minimumFreeBytes: 0n, activeReserveBytes: 50n,
    scanMaxEntries: 100, scanMaxDepth: 10, scanDeadlineMs: 1000,
    recheckBytes: 8 * 1024 * 1024, recheckIntervalMs: 1000,
  };
  const reservation = await reserveRenderStorage(root, {
    reservationId: ID, jobId: ID, declaredBytes: 10n, storageConfig: config,
    storageOps: { scan: async () => ({ allocatedBytes: 0n }), available: async () => 1_000_000_000n },
  });
  const env = {
    ...process.env, JOBS_ROOT: root,
    JOBS_STORAGE_QUOTA_BYTES: "1000000000", JOBS_STORAGE_MIN_FREE_BYTES: "0",
    JOBS_STORAGE_ACTIVE_RESERVE_BYTES: "50", JOBS_STORAGE_SCAN_MAX_ENTRIES: "100",
    JOBS_STORAGE_SCAN_MAX_DEPTH: "10", JOBS_STORAGE_SCAN_DEADLINE_MS: "1000",
    JOBS_STORAGE_RECHECK_BYTES: String(8 * 1024 * 1024),
    JOBS_STORAGE_RECHECK_INTERVAL_MS: "1000",
  };
  const invoke = (command) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve("scripts/render-storage-admission.mjs")], {
      env, stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => resolve({
      code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString(),
    }));
    child.stdin.end(JSON.stringify(command));
  });
  assert.deepEqual(await invoke({ operation: "heartbeat", reservationId: ID, token: reservation.token }), {
    code: 0, stdout: '{"ok":true}\n', stderr: "",
  });
  assert.deepEqual(await invoke({ operation: "release", reservationId: ID, token: reservation.token, terminalState: "completed" }), {
    code: 0, stdout: '{"ok":true}\n', stderr: "",
  });
  const invalid = await invoke({ operation: "heartbeat", reservationId: ID, token: "secret" });
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, "");
  assert.equal(invalid.stderr, "render_storage_failed\n");
});

test("render queue bridge maps sanitized storage admission failures", async () => {
  await assert.rejects(runRenderQueuePython("/safe/job", { operation: "create" }, {
    execFileImpl: (_b, _a, _o, callback) => {
      callback(Object.assign(new Error("secret path"), { code: 6 }), Buffer.alloc(0), Buffer.from("secret"));
      return { stdin: { on() {}, end() {} } };
    },
  }), (error) => error instanceof RenderStorageError && error.code === "storage_admission_lost");
});
