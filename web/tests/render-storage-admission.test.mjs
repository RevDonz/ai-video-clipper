// Render storage reservations (the admission of an export and the shared accounting that primary
// job admission reads). Moved here from the retired candidate editor's render-requests tests; the
// reservation of a request of that retired editor is released whatever its state (T4.1).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  bindRenderStorage,
  heartbeatRenderStorage,
  releaseRenderStorage,
  reserveRenderStorage,
} from "../lib/render-storage-admission.mjs";
import { readSharedStorageAccounting, requestReleasesReservation } from "../lib/shared-storage-accounting.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER = "223e4567-e89b-42d3-a456-426614174000";
const RENDER_ID = "323e4567-e89b-42d3-a456-426614174000";
const CONFIG = {
  quotaBytes: 1000n, minimumFreeBytes: 0n, activeReserveBytes: 20n,
  scanMaxEntries: 100, scanMaxDepth: 10, scanDeadlineMs: 1000,
  recheckBytes: 10, recheckIntervalMs: 10,
};
const STORAGE_OPS = { scan: async () => ({ allocatedBytes: 0n }), available: async () => 1000n };

async function tempRoot(t, prefix) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function writeRequest(root, value) {
  const requests = path.join(root, ID, "analysis", "render-requests");
  await mkdir(requests, { recursive: true });
  await writeFile(path.join(requests, `${value.render_id}.json`), JSON.stringify(value));
}

// A reservation bound to RENDER_ID; `request` (or nothing) is written as that render's file.
async function bound(t, prefix, request) {
  const root = await tempRoot(t, prefix);
  const reservation = await reserveRenderStorage(root, {
    reservationId: ID, jobId: ID, declaredBytes: 10n, storageConfig: CONFIG, storageOps: STORAGE_OPS,
  });
  assert.equal(await bindRenderStorage(root, ID, reservation.token, RENDER_ID), true);
  if (request) {
    await writeRequest(root, {
      render_id: RENDER_ID, storage_reservation_id: ID, storage_reservation_token: reservation.token, ...request,
    });
  }
  return { root, reservation };
}

const reservationFile = (root) => readFile(path.join(root, ".render-reservations", `${ID}.json`), "utf8")
  .catch((error) => error.code);

async function admitAnother(root) {
  await reserveRenderStorage(root, {
    reservationId: OTHER, jobId: ID, declaredBytes: 10n, storageConfig: CONFIG, storageOps: STORAGE_OPS,
  });
}

test("render reservations serialize admission and fence heartbeat and release", async (t) => {
  const root = await tempRoot(t, "render-storage-");
  const config = { ...CONFIG, quotaBytes: 150n, activeReserveBytes: 50n };
  const first = await reserveRenderStorage(root, {
    reservationId: ID, jobId: ID, declaredBytes: 50n, storageConfig: config, storageOps: STORAGE_OPS,
  });
  assert.equal(first.reservedBytes, "100");
  await assert.rejects(reserveRenderStorage(root, {
    reservationId: OTHER, jobId: ID, declaredBytes: 1n, storageConfig: config, storageOps: STORAGE_OPS,
  }), (error) => error.code === "storage_quota_exhausted" && error.status === 507);
  assert.equal(await heartbeatRenderStorage(root, ID, "wrong", config, STORAGE_OPS), false);
  assert.equal(await heartbeatRenderStorage(root, ID, first.token, config, STORAGE_OPS), true);
  assert.equal(await releaseRenderStorage(root, ID, "wrong", "failed"), false);
  assert.equal(await releaseRenderStorage(root, ID, first.token, "completed"), true);
  assert.equal(await reservationFile(root), "ENOENT");
});

test("render reservation restart recovery reaps abandoned admission", async (t) => {
  const root = await tempRoot(t, "render-recovery-");
  const directory = path.join(root, ".render-reservations");
  await mkdir(directory);
  await writeFile(path.join(directory, `${ID}.json`), JSON.stringify({
    version: 1, reservationId: ID, jobId: ID, renderId: null, state: "admitting",
    tokenHash: "0".repeat(64), declaredBytes: "10", workReserveBytes: "20",
    createdAt: "2020-01-01T00:00:00.000Z", heartbeatAt: "2020-01-01T00:00:00.000Z",
    expiresAt: "2020-01-01T00:00:00.000Z",
  }));
  const recovered = await reserveRenderStorage(root, {
    reservationId: OTHER, jobId: ID, declaredBytes: 10n, storageConfig: { ...CONFIG, quotaBytes: 100n },
    storageOps: STORAGE_OPS, now: Date.parse("2026-01-01T00:00:00Z"),
  });
  assert.ok(recovered.token);
});

for (const state of ["completed", "failed", "cancelled"]) {
  test(`admission reaps the reservation of a ${state} export`, async (t) => {
    const { root } = await bound(t, "render-terminal-", { version: "render-request-v3", state });
    await admitAnother(root);
    assert.equal(await reservationFile(root), "ENOENT");
  });
}

for (const state of ["queued", "claimed", "rendering"]) {
  test(`admission keeps the reservation of a ${state} export`, async (t) => {
    const { root } = await bound(t, "render-live-", { version: "render-request-v3", state });
    await admitAnother(root);
    assert.notEqual(await reservationFile(root), "ENOENT");
  });
}

for (const state of ["queued", "claimed", "rendering", "completed", "failed"]) {
  test(`admission reaps the reservation of a ${state} request of the retired candidate editor`, async (t) => {
    // nothing renders those any more: a queued one would otherwise hold its bytes forever
    const { root } = await bound(t, "render-retired-", { version: "render-request-v2", state });
    await admitAnother(root);
    assert.equal(await reservationFile(root), "ENOENT");
  });
}

test("a reservation is released only by its own request and token", async (t) => {
  const { root, reservation } = await bound(t, "render-owner-");
  const item = { renderId: RENDER_ID, reservationId: ID, tokenHash: JSON.parse(await reservationFile(root)).tokenHash };
  const own = { render_id: RENDER_ID, storage_reservation_id: ID, storage_reservation_token: reservation.token };
  assert.equal(requestReleasesReservation({ ...own, version: "render-request-v3", state: "completed" }, item), true);
  assert.equal(requestReleasesReservation({ ...own, version: "render-request-v2", state: "queued" }, item), true);
  for (const request of [
    { ...own, version: "render-request-v3", state: "rendering" },
    { ...own, version: "render-request-v1", state: "completed" },
    { ...own, version: "render-request-v4", state: "completed" },
    { ...own, version: "render-request-v3", state: "completed", render_id: OTHER },
    { ...own, version: "render-request-v2", state: "queued", storage_reservation_id: OTHER },
    { ...own, version: "render-request-v2", state: "queued", storage_reservation_token: "other" },
    { ...own, version: "render-request-v3", state: "completed", storage_reservation_token: 7 },
    null, "render-request-v2",
  ]) assert.equal(requestReleasesReservation(request, item), false, JSON.stringify(request));
  assert.equal(requestReleasesReservation({ ...own, version: "render-request-v2", state: "queued" }, { ...item, renderId: null }), false);
});

test("shared accounting counts live exports only", async (t) => {
  const cases = [
    [{ version: "render-request-v3", state: "rendering" }, true],
    [{ version: "render-request-v3", state: "queued" }, true],
    [{ version: "render-request-v3", state: "completed" }, false],
    [{ version: "render-request-v3", state: "cancelled" }, false],
    [{ version: "render-request-v2", state: "queued" }, false],
    [{ version: "render-request-v2", state: "completed" }, false],
    [null, true],
  ];
  for (const [request, counted] of cases) {
    const { root } = await bound(t, "render-accounting-", request);
    const accounting = await readSharedStorageAccounting(root);
    assert.equal(accounting.renderReservedBytes > 0n, counted, JSON.stringify(request));
  }
});

test("render worker storage CLI uses bounded stdin and sanitized output", async (t) => {
  const root = await tempRoot(t, "render-storage-cli-");
  const config = { ...CONFIG, quotaBytes: 1_000_000_000n, activeReserveBytes: 50n, recheckBytes: 8 * 1024 * 1024, recheckIntervalMs: 1000 };
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
    const child = spawn(process.execPath, [path.join(WEB, "scripts", "render-storage-admission.mjs")], {
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
