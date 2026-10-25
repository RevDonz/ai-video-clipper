// Buat klip's submit (lib/dashboard-submit.mjs, 05-ui-dashboard.md §6.3): the same multipart POST
// to /api/jobs, the upload's percent on the button, then the new project's page (P4).
import assert from "node:assert/strict";
import test from "node:test";

import { failedJobHref, projectAfterSubmit, sendJob, submitPhase, uploadPercent } from "../lib/dashboard-submit.mjs";
import { processStatus } from "../lib/status-view.mjs";

class FakeRequest {
  static last = null;
  constructor() {
    this.listeners = {};
    this.uploadListeners = {};
    this.upload = { addEventListener: (name, fn) => { this.uploadListeners[name] = fn; } };
    FakeRequest.last = this;
  }
  open(method, url) { this.method = method; this.url = url; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  send(body) { this.body = body; }
}

test("the job is POSTed to /api/jobs as it is, with the upload's percent and its end reported", async () => {
  const progress = [];
  let uploaded = 0;
  const body = { form: true };
  const sent = sendJob(body, { Request: FakeRequest, onProgress: (value) => progress.push(value), onUploaded: () => { uploaded += 1; } });
  const request = FakeRequest.last;
  assert.deepEqual([request.method, request.url, request.body], ["POST", "/api/jobs", body]);
  request.uploadListeners.progress({ lengthComputable: true, loaded: 50, total: 200 });
  request.uploadListeners.progress({ lengthComputable: false, loaded: 1, total: 0 });
  request.uploadListeners.load();
  request.status = 201;
  request.responseText = JSON.stringify({ job: { id: "8c2e4f60-7a1b-4c3d-9e5f-0a1b2c3d4e5f" } });
  request.listeners.load();
  const result = await sent;
  assert.deepEqual(progress, [25, null]);
  assert.equal(uploaded, 1);
  assert.equal(result.status, 201);
  assert.equal(projectAfterSubmit(result), "/projects/8c2e4f60-7a1b-4c3d-9e5f-0a1b2c3d4e5f");
  assert.equal(failedJobHref(result), null);
});

test("an answer that is not JSON is an empty payload; a request that never reached the server rejects", async () => {
  const sent = sendJob({}, { Request: FakeRequest });
  FakeRequest.last.status = 502;
  FakeRequest.last.responseText = "<html>";
  FakeRequest.last.listeners.load();
  assert.deepEqual(await sent, { status: 502, payload: {} });
  const lost = sendJob({}, { Request: FakeRequest });
  FakeRequest.last.listeners.error();
  await assert.rejects(lost, TypeError);
});

test("a refusal stays on the page; one that still made a job links to it", () => {
  assert.equal(projectAfterSubmit({ status: 400, payload: { error: "x" } }), null);
  assert.equal(projectAfterSubmit({ status: 201, payload: { job: { id: "../../x" } } }), null, "only a job id");
  assert.equal(failedJobHref({ status: 507, payload: { jobId: "8c2e4f60-7a1b-4c3d-9e5f-0a1b2c3d4e5f" } }), "/projects/8c2e4f60-7a1b-4c3d-9e5f-0a1b2c3d4e5f");
  assert.equal(failedJobHref({ status: 507, payload: {} }), null);
});

test("the button names the phase: uploading a file, checking it, or preparing a link's job", () => {
  assert.equal(submitPhase({ sending: false, upload: true }), null);
  assert.equal(submitPhase({ sending: true, upload: true, uploaded: false }), "uploading");
  assert.equal(submitPhase({ sending: true, upload: true, uploaded: true }), "checking");
  assert.equal(submitPhase({ sending: true, upload: false }), "preparing");
  assert.equal(uploadPercent({ lengthComputable: true, loaded: 300, total: 200 }), 100);
  assert.equal(uploadPercent(null), null);
});

test("every job status maps onto one of the five process words (05 §5)", () => {
  const cases = {
    queued: ["queued", "default"], preparing: ["running", "default"], downloading: ["running", "default"],
    processing: ["running", "default"], completed: ["completed", "success"], failed: ["failed", "danger"],
    cancelled: ["cancelled", "default"], deleting: ["deleting", "default"], weird: ["unknown", "default"],
  };
  for (const [status, [key, tone]] of Object.entries(cases)) {
    assert.deepEqual(processStatus({ status }), { key, tone, running: key === "running" }, status);
  }
  assert.equal(processStatus(null).key, "unknown");
});
