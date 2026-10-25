// "Batalkan" on the pages: the client call, the labels of a cancelled job and the wiring of the
// confirmation on the dashboard and the project page (e2e/cancel-job.spec.mjs runs it in a browser).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { cancelJob, jobCancellable } from "../lib/job-cancel.mjs";
import {
  JOB_STAGE_LABELS,
  JOB_STATUS_LABELS,
  jobFinished,
  jobPercentText,
  jobStageText,
  jobWaitingText,
} from "../lib/dashboard-view.mjs";
import {
  isActiveStatus,
  matchesProjectFilter,
  projectRowDetail,
  statusLabel,
} from "../lib/project-view.mjs";

// --- client call ---------------------------------------------------------------------------------

function fakeFetch(status, body, calls = []) {
  return async (url, init) => {
    calls.push([url, init]);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}

test("cancelJob posts to the job's cancel route and reads each answer", async () => {
  const id = crypto.randomUUID();
  const calls = [];
  const ok = await cancelJob(id, { fetchImpl: fakeFetch(200, { job: { id, status: "cancelled" }, cancelled: true }, calls) });
  assert.deepEqual(ok, { type: "cancelled", job: { id, status: "cancelled" } });
  assert.equal(calls[0][0], `/api/jobs/${id}/cancel`);
  assert.equal(calls[0][1].method, "POST");

  const finished = await cancelJob(id, { fetchImpl: fakeFetch(409, { job: { id, status: "completed" }, code: "job_finished", cancelled: false }) });
  assert.equal(finished.type, "finished");
  assert.equal(finished.job.status, "completed");
  assert.match(finished.message, /selesai/);

  const login = await cancelJob(id, { next: `/projects/${id}`, fetchImpl: fakeFetch(401, {}) });
  assert.deepEqual(login, { type: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${id}`)}` });

  const missing = await cancelJob(id, { fetchImpl: fakeFetch(404, { error: "Job tidak ditemukan" }) });
  assert.equal(missing.type, "error");
  assert.match(missing.message, /tidak ada|sudah dihapus/);

  const broken = await cancelJob(id, { fetchImpl: fakeFetch(500, { code: "cancel_failed" }) });
  assert.equal(broken.type, "error");
  assert.match(broken.message, /Coba lagi/);

  const offline = await cancelJob(id, { fetchImpl: async () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(offline.type, "error");
  assert.match(offline.message, /koneksi/);
});

test("only a queued or running job offers Batalkan", () => {
  for (const status of ["queued", "preparing", "downloading", "processing"]) assert.equal(jobCancellable({ status }), true, status);
  for (const status of ["completed", "failed", "cancelled", "deleting", undefined]) assert.equal(jobCancellable({ status }), false, String(status));
  assert.equal(jobCancellable(null), false);
});

// --- labels ---------------------------------------------------------------------------------------

test("a cancelled job reads as Dibatalkan, finished and distinct from a failure", () => {
  const job = { status: "cancelled", stage: "cancelled", progress: 42, stageDetail: "Dibatalkan sebelum selesai" };
  assert.equal(JOB_STATUS_LABELS.cancelled, "Dibatalkan");
  assert.equal(JOB_STAGE_LABELS.cancelled, "Dibatalkan");
  assert.equal(jobStageText(job), "Dibatalkan");
  assert.equal(jobFinished(job), true, "the dashboard stops polling");
  assert.equal(jobPercentText(job), null, "42% would read as progress still being made");
  assert.match(jobWaitingText(job), /dibatalkan/i);
  assert.equal(jobWaitingText({ status: "processing" }), "Klip muncul di sini setelah selesai dirender.");

  assert.equal(statusLabel("cancelled"), "Dibatalkan");
  assert.equal(isActiveStatus("cancelled"), false, "the project page stops polling");
  assert.equal(projectRowDetail(job), "Dibatalkan sebelum selesai");
  assert.equal(matchesProjectFilter(job, "active"), false);
  assert.equal(matchesProjectFilter(job, "failed"), false, "a cancel is not a failure");
});

// --- pages ------------------------------------------------------------------------------------------

const read = (relative) => readFile(new URL(relative, import.meta.url), "utf8");

// The project page's progress panel offers Batalkan (Buat klip shows no job any more, 05 §2 P4):
// an AlertDialog inside the page, whose focus starts on Lanjutkan proses; React Aria closes it
// on Escape and returns the focus to Batalkan.
test("the project page offers Batalkan with an in-page confirmation", async () => {
  const component = await read("../components/CancelJob.jsx");
  assert.match(component, /cancelJob\(/);
  assert.match(component, /<AlertDialog isOpen=\{open\} onOpenChange=\{change\}>/);
  assert.match(component, /<AlertDialog\.Heading>\{t\("cancel\.confirm"\)\}<\/AlertDialog\.Heading>/);
  assert.match(component, /<Button variant="secondary" autoFocus isDisabled=\{busy\} onPress=\{\(\) => change\(false\)\}>\{t\("cancel\.keep"\)\}<\/Button>/);
  assert.match(component, /\{busy \? t\("cancel\.busy"\) : t\("cancel\.yes"\)\}/);
  const id = JSON.parse(await read("../messages/id/project.json")).cancel;
  assert.deepEqual([id.ask, id.confirm, id.keep, id.yes], ["Batalkan", "Batalkan proses ini?", "Lanjutkan proses", "Ya, batalkan"]);
  assert.doesNotMatch(component, /(?<![\w.])confirm\(/, "a modal confirm() blocks the page");
  const panel = await read("../components/ProjectProgress.jsx");
  assert.match(panel, /<CancelJob\b/);
  assert.match(panel, /jobCancellable\(/);
  for (const page of ["../app/dashboard/page.jsx", "../app/projects/[id]/page.jsx", "../components/ProjectProgress.jsx"]) {
    assert.doesNotMatch(await read(page), /(?<![\w.])confirm\(/, page);
  }
  assert.doesNotMatch(await read("../app/dashboard/page.jsx"), /<CancelJob\b/);
});
