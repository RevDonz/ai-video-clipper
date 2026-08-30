import assert from "node:assert/strict";
import test from "node:test";

import {
  RenderQueueConflictError,
  RenderQueueInvalidError,
  runRenderQueuePython,
  sanitizeRenderStatus,
  validateRenderRequest,
} from "../lib/render-requests.mjs";
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
