import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { POST, streamPrimaryMultipart } from "../app/api/jobs/route.js";
import { createSessionToken } from "../lib/auth.mjs";

const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function multipart(boundary, parts) {
  return Buffer.from(parts.map(({ disposition, contentType, body }) =>
    `--${boundary}\r\nContent-Disposition: form-data; ${disposition}\r\n${contentType ? `Content-Type: ${contentType}\r\n` : ""}\r\n${body}\r\n`).join("") + `--${boundary}--\r\n`);
}

function streamedRequest(body, boundary, chunk = 7) {
  return {
    headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` }),
    body: new ReadableStream({
      start(controller) {
        for (let offset = 0; offset < body.length; offset += chunk) controller.enqueue(body.subarray(offset, offset + chunk));
        controller.close();
      },
    }),
  };
}

test("streaming multipart counts consumed bytes independently of Content-Length", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "primary-upload-"));
  const boundary = "stream-limit-boundary";
  const body = multipart(boundary, [{ disposition: 'name="video"; filename="clip.mp4"', contentType: "video/mp4", body: "x".repeat(200) }]);
  await assert.rejects(streamPrimaryMultipart(streamedRequest(body, boundary), root, 20, 64), /large|limit/i);
});

test("streaming multipart writes one bounded upload and returns bounded fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "primary-upload-"));
  const boundary = "stream-success-boundary";
  const body = multipart(boundary, [
    { disposition: 'name="limit"', body: "3" },
    { disposition: 'name="video"; filename="clip.mp4"', contentType: "video/mp4", body: "video-bytes" },
  ]);
  const parsed = await streamPrimaryMultipart(streamedRequest(body, boundary), root, 100, 4096);
  assert.equal(parsed.form.get("limit"), "3");
  assert.equal(parsed.upload.name, "clip.mp4");
  assert.equal(parsed.upload.size, 11);
  assert.equal(await readFile(parsed.upload.path, "utf8"), "video-bytes");
});

test("streaming multipart heartbeats throughout continuously chunked uploads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "primary-upload-"));
  const boundary = "continuous-heartbeat-boundary";
  const body = multipart(boundary, [{ disposition: 'name="video"; filename="clip.mp4"', contentType: "video/mp4", body: "video".repeat(20) }]);
  let heartbeats = 0;
  const request = {
    headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` }),
    body: new ReadableStream({
      async start(controller) {
        for (let offset = 0; offset < body.length; offset += 3) {
          controller.enqueue(body.subarray(offset, offset + 3));
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        controller.close();
      },
    }),
  };
  const parsed = await streamPrimaryMultipart(request, root, 200, 4096, { heartbeat: async () => { heartbeats += 1; }, heartbeatMs: 8 });
  assert.equal(parsed.upload.size, 100);
  assert.ok(heartbeats >= 2);
  const stoppedAt = heartbeats;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(heartbeats, stoppedAt);
});

test("streaming multipart aborts closed and stops its timer when renewal fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "primary-upload-"));
  const boundary = "failed-heartbeat-boundary";
  const body = multipart(boundary, [{ disposition: 'name="video"; filename="clip.mp4"', contentType: "video/mp4", body: "video".repeat(20) }]);
  let heartbeats = 0;
  const request = {
    headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` }),
    body: new ReadableStream({
      async start(controller) {
        for (let offset = 0; offset < body.length; offset += 3) {
          controller.enqueue(body.subarray(offset, offset + 3));
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        controller.close();
      },
    }),
  };
  await assert.rejects(streamPrimaryMultipart(request, root, 200, 4096, {
    heartbeat: async () => { heartbeats += 1; throw new Error("reservation lost"); }, heartbeatMs: 8,
  }), /reservation lost/);
  const stoppedAt = heartbeats;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(heartbeats, stoppedAt);
});

test("streaming multipart fails closed before touching the body when the first storage recheck rejects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "primary-upload-"));
  const boundary = "late-heartbeat-boundary";
  const body = multipart(boundary, [{ disposition: 'name="video"; filename="clip.mp4"', contentType: "video/mp4", body: "video".repeat(20) }]);
  const heartbeatStarted = deferred();
  let cancellations = 0;
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(body);
      await heartbeatStarted.promise;
      controller.close();
    },
  });
  const reader = stream.getReader();
  const request = {
    headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` }),
    body: {
      getReader: () => ({
        read: (...args) => reader.read(...args),
        cancel: (...args) => { cancellations += 1; return reader.cancel(...args); },
        releaseLock: () => reader.releaseLock(),
      }),
    },
  };
  await assert.rejects(streamPrimaryMultipart(request, root, 200, 4096, {
    heartbeat: async () => {
      heartbeatStarted.resolve();
      await new Promise((_, reject) => setTimeout(() => reject(new Error("late reservation loss")), 15));
    },
    heartbeatMs: 1,
  }), /late reservation loss/);
  assert.equal(cancellations, 0);
});

test("streaming multipart heartbeats admission while the request stalls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "primary-upload-"));
  const boundary = "heartbeat-boundary";
  const body = multipart(boundary, [{ disposition: 'name="video"; filename="clip.mp4"', contentType: "video/mp4", body: "video" }]);
  let heartbeats = 0;
  const request = {
    headers: new Headers({ "content-type": `multipart/form-data; boundary=${boundary}` }),
    body: new ReadableStream({
      start(controller) { setTimeout(() => { controller.enqueue(body); controller.close(); }, 30); },
    }),
  };
  await streamPrimaryMultipart(request, root, 100, 4096, { heartbeat: async () => { heartbeats += 1; }, heartbeatMs: 5 });
  assert.ok(heartbeats >= 2);
});

test("job creation rejects cross-site mutation before body and admission work", async () => {
  const previous = Object.fromEntries(Object.keys(AUTH_ENV).map((key) => [key, process.env[key]]));
  Object.assign(process.env, AUTH_ENV);
  try {
    const token = createSessionToken(AUTH_ENV, 2_000_000_000);
    const response = await POST(new Request("http://internal:3000/api/jobs", {
      method: "POST",
      headers: { Cookie: `potongin_session=${token}`, Origin: "https://evil.example", Host: "clips.example" },
    }));
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "csrf_rejected");
    assert.equal(response.headers.get("cache-control"), "no-store");
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("every job POST failure is non-cacheable and configuration failures are sanitized", async () => {
  const names = [
    ...Object.keys(AUTH_ENV), "PRIMARY_MAX_ACTIVE_JOBS", "PRIMARY_WORKER_CONCURRENCY",
    "PRIMARY_MAX_ATTEMPTS", "PRIMARY_LEASE_MS", "MAX_UPLOAD_BYTES",
    "JOBS_STORAGE_QUOTA_BYTES", "JOBS_STORAGE_MIN_FREE_BYTES", "JOBS_STORAGE_ACTIVE_RESERVE_BYTES",
    "JOBS_STORAGE_SCAN_MAX_ENTRIES", "JOBS_STORAGE_SCAN_MAX_DEPTH",
  ];
  const previous = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  Object.assign(process.env, AUTH_ENV, {
    PRIMARY_MAX_ACTIVE_JOBS: "2", PRIMARY_WORKER_CONCURRENCY: "1",
    PRIMARY_MAX_ATTEMPTS: "3", PRIMARY_LEASE_MS: "60000", MAX_UPLOAD_BYTES: "1000",
  });
  for (const key of names.filter((key) => key.startsWith("JOBS_STORAGE_"))) delete process.env[key];
  try {
    const token = createSessionToken(AUTH_ENV, 2_000_000_000);
    const response = await POST(new Request("http://clips.example/api/jobs", {
      method: "POST",
      headers: {
        Cookie: `potongin_session=${token}`, Origin: "http://clips.example", Host: "clips.example",
        "Sec-Fetch-Site": "same-origin", "Content-Length": "0",
        "Content-Type": "multipart/form-data; boundary=x",
      },
      body: Buffer.alloc(0),
    }));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(body, {
      error: "Status penyimpanan server tidak dapat diverifikasi.",
      code: "storage_admission_unavailable", retryable: true, jobId: null,
    });
    assert.doesNotMatch(JSON.stringify(body), /JOBS_STORAGE|MAX_UPLOAD|\/data\/jobs/);

    Object.assign(process.env, {
      JOBS_STORAGE_QUOTA_BYTES: "1000000", JOBS_STORAGE_MIN_FREE_BYTES: "0",
      JOBS_STORAGE_ACTIVE_RESERVE_BYTES: "1000", JOBS_STORAGE_SCAN_MAX_ENTRIES: "100",
      JOBS_STORAGE_SCAN_MAX_DEPTH: "10",
    });
    const invalid = await POST(new Request("http://clips.example/api/jobs", {
      method: "POST",
      headers: {
        Cookie: `potongin_session=${token}`, Origin: "http://clips.example", Host: "clips.example",
        "Sec-Fetch-Site": "same-origin",
      },
    }));
    assert.equal(invalid.status, 411);
    assert.equal(invalid.headers.get("cache-control"), "no-store");
    assert.deepEqual(await invalid.json(), { error: "Permintaan job tidak valid.", code: "invalid_request" });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
