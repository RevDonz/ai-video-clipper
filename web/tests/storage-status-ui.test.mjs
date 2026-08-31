import assert from "node:assert/strict";
import test from "node:test";

import { createStorageStatusHandler } from "../app/api/storage/status/route.js";
import {
  createStorageStatusRecovery,
  recoverFailedJobSelection,
  storageStatusView,
} from "../lib/dashboard-storage-status.mjs";
import { toStorageStatusDto } from "../lib/storage-status-dto.mjs";

const metrics = {
  quotaBytes: 1000n,
  allocatedBytes: 200n,
  projectedBytes: 350n,
  availableBytes: 800n,
  minimumFreeBytes: 100n,
  activeReserveBytes: 50n,
  reservedBytes: 75n,
  anticipatedWriteBytes: 150n,
  availableAfterWritesBytes: 650n,
};

test("storage status DTO emits only a strict schema with decimal byte strings", () => {
  const dto = toStorageStatusDto({
    allowed: true,
    code: null,
    ...metrics,
    jobsRoot: "/private/jobs",
    nested: { path: "/private/jobs/secret" },
  });
  assert.deepEqual(dto, {
    allowed: true,
    code: null,
    quotaBytes: "1000",
    allocatedBytes: "200",
    projectedBytes: "350",
    availableBytes: "800",
    minimumFreeBytes: "100",
    activeReserveBytes: "50",
    reservedBytes: "75",
    anticipatedWriteBytes: "150",
    availableAfterWritesBytes: "650",
  });
  assert.doesNotMatch(JSON.stringify(dto), /private|path|jobsRoot/);
  assert.throws(() => toStorageStatusDto({ allowed: true, code: null, ...metrics, availableBytes: -1n }));
  assert.throws(() => toStorageStatusDto({ allowed: true, code: null, ...metrics, quotaBytes: "1e3" }));
});

test("storage route requires auth, is no-store, and never leaks service paths", async () => {
  let calls = 0;
  const handler = createStorageStatusHandler({
    authorize: (request) => request.headers.get("authorization") === "ok"
      ? null
      : Response.json({ error: "denied" }, { status: 401 }),
    loadStatus: async () => {
      calls += 1;
      return { allowed: true, code: null, ...metrics, jobsRoot: "/data/jobs/private" };
    },
  });
  const denied = await handler(new Request("http://local/api/storage/status"));
  assert.equal(denied.status, 401);
  assert.equal(calls, 0);
  assert.equal(denied.headers.get("Cache-Control"), "no-store");

  const response = await handler(new Request("http://local/api/storage/status", { headers: { authorization: "ok" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["admission"]);
  assert.deepEqual(body.admission, toStorageStatusDto({ allowed: true, code: null, ...metrics }));
  assert.doesNotMatch(JSON.stringify(body), /\/data\/jobs|private/);
});

test("storage route sanitizes unavailable failures and uses 503", async () => {
  const handler = createStorageStatusHandler({
    authorize: () => null,
    loadStatus: async () => { throw Object.assign(new Error("failed /data/jobs/private"), { code: "storage_admission_unavailable" }); },
  });
  const response = await handler(new Request("http://local/api/storage/status"));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await response.json(), { admission: { allowed: false, code: "storage_admission_unavailable" } });
});

test("unknown and unavailable storage states warn without disabling submit", () => {
  for (const admission of [
    null,
    { allowed: false, code: "storage_admission_unavailable" },
    { allowed: false, code: "future_storage_code" },
  ]) {
    const view = storageStatusView(admission);
    assert.equal(view.warning, true);
    assert.equal(view.submitBlocked, false);
  }
  for (const code of ["storage_quota_exhausted", "storage_free_space_low"]) {
    const view = storageStatusView({ allowed: false, code });
    assert.equal(view.warning, true);
    assert.equal(view.submitBlocked, true);
  }
  assert.equal(storageStatusView({ allowed: true, code: null }).warning, false);
});

test("storage recovery polls boundedly after network and 503 failures and recovers without reload", async () => {
  const responses = [
    new Error("offline"),
    new Response(JSON.stringify({ admission: { allowed: false, code: "storage_admission_unavailable" } }), { status: 503 }),
    new Response(JSON.stringify({ admission: { allowed: true, code: null } }), { status: 200 }),
  ];
  const timers = [];
  const states = [];
  const recovery = createStorageStatusRecovery({
    fetchImpl: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    schedule: (callback, delay) => { timers.push({ callback, delay }); return timers.length; },
    cancel: () => {},
    delays: [10, 20],
    onChange: (state) => states.push(state),
  });

  await recovery.start();
  assert.equal(states.at(-1).submitBlocked, false);
  assert.equal(states.at(-1).warning, true);
  assert.deepEqual(timers.map(({ delay }) => delay), [10]);
  await timers.shift().callback();
  assert.equal(states.at(-1).submitBlocked, false);
  assert.deepEqual(timers.map(({ delay }) => delay), [20]);
  await timers.shift().callback();
  assert.equal(states.at(-1).warning, false);
  assert.equal(states.at(-1).admission.allowed, true);
  assert.equal(timers.length, 0);
});

test("known quota blocks submission but polling can recover without reload", async () => {
  const responses = [
    new Response(JSON.stringify({ admission: { allowed: false, code: "storage_quota_exhausted" } }), { status: 507 }),
    new Response(JSON.stringify({ admission: { allowed: true, code: null } }), { status: 200 }),
  ];
  const timers = [];
  const states = [];
  const recovery = createStorageStatusRecovery({
    fetchImpl: async () => responses.shift(),
    schedule: (callback) => { timers.push(callback); return timers.length; },
    cancel: () => {},
    delays: [1],
    onChange: (state) => states.push(state),
  });
  await recovery.start();
  assert.equal(states.at(-1).submitBlocked, true);
  assert.equal(timers.length, 1);
  await timers.shift()();
  assert.equal(states.at(-1).submitBlocked, false);
  assert.equal(states.at(-1).warning, false);
});

test("explicit retry restarts a bounded recovery sequence", async () => {
  let calls = 0;
  const timers = [];
  const recovery = createStorageStatusRecovery({
    fetchImpl: async () => { calls += 1; throw new Error("offline"); },
    schedule: (callback) => { timers.push(callback); return timers.length; },
    cancel: () => {},
    delays: [1],
    onChange: () => {},
  });
  await recovery.start();
  await timers.shift()();
  assert.equal(calls, 2);
  assert.equal(timers.length, 0);
  await recovery.retry();
  assert.equal(calls, 3);
  assert.equal(timers.length, 1);
});

test("retry supersedes an in-flight request and ignores its stale result", async () => {
  const pending = [];
  const states = [];
  const recovery = createStorageStatusRecovery({
    fetchImpl: (_url, options) => new Promise((resolve) => pending.push({ resolve, signal: options.signal })),
    schedule: () => assert.fail("an allowed result must not schedule polling"),
    cancel: () => {},
    onChange: (state) => states.push(state),
  });

  const first = recovery.start();
  const second = recovery.retry();
  assert.equal(pending[0].signal.aborted, true);
  pending[1].resolve(new Response(JSON.stringify({ admission: { allowed: true, code: null } })));
  await second;
  pending[0].resolve(new Response(JSON.stringify({ admission: { allowed: false, code: "storage_quota_exhausted" } }), { status: 507 }));
  await first;
  assert.equal(states.length, 1);
  assert.equal(states[0].admission.allowed, true);
});

test("dispose aborts in-flight work and prevents updates or timers", async () => {
  let request;
  const states = [];
  const timers = [];
  const recovery = createStorageStatusRecovery({
    fetchImpl: (_url, options) => new Promise((resolve) => { request = { resolve, signal: options.signal }; }),
    schedule: (callback) => { timers.push(callback); return callback; },
    cancel: () => {},
    onChange: (state) => states.push(state),
  });
  const started = recovery.start();
  recovery.dispose();
  assert.equal(request.signal.aborted, true);
  request.resolve(new Response(JSON.stringify({ admission: { allowed: false, code: "storage_admission_unavailable" } }), { status: 503 }));
  await started;
  assert.deepEqual(states, []);
  assert.deepEqual(timers, []);
});

test("malformed successful status payload is treated as unavailable", async () => {
  const states = [];
  const recovery = createStorageStatusRecovery({
    fetchImpl: async () => new Response(JSON.stringify({ admission: { allowed: true, code: null, quotaBytes: "1e3" } })),
    schedule: () => 1,
    cancel: () => {},
    delays: [],
    onChange: (state) => states.push(state),
  });
  await recovery.start();
  assert.equal(states[0].unavailable, true);
});

test("failed job selection is committed before fallible list reconciliation", async () => {
  const events = [];
  await recoverFailedJobSelection("failed-job", {
    select: (id) => events.push(`select:${id}`),
    refreshJobs: async (id) => { events.push(`refresh:${id}`); throw new Error("list unavailable"); },
  });
  assert.deepEqual(events, ["select:failed-job", "refresh:failed-job"]);
});
