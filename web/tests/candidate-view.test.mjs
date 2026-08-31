import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GET as getJobDetail } from "../app/api/jobs/[id]/route.js";
import { createSessionToken } from "../lib/auth.mjs";
import {
  buildCandidateView,
  buildFeedbackView,
  classifyFeedbackSaveFailure,
  createFeedbackSaveAttempt,
  formatDuration,
  formatScore,
  loadProjectDetail,
  profileLabel,
  validateFeedbackPayload,
} from "../lib/candidate-view.mjs";

const candidate = (overrides = {}) => ({
  id: "candidate-1",
  displayOrder: 2,
  rank: 1,
  start: 65.25,
  end: 95.75,
  duration: 30.5,
  text: "Pembuka yang mandiri dan memiliki payoff.",
  profile: "standard",
  score: 7.25,
  reasons: ["Pembuka langsung."],
  topicTerms: ["retensi"],
  features: { hookStrength: 8, visualActivity: 2, penalty: 0 },
  scoreBreakdown: { contributions: [], finalScore: 7.25 },
  measuredMedia: null,
  ...overrides,
});

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const AUTH_ENV = {
  APP_USERNAME: "admin",
  APP_PASSWORD: "secret-value",
  APP_SESSION_SECRET: "a-long-random-session-secret-value",
};

test("job detail disables storage for auth, validation, success, missing, and server error responses", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipper-job-detail-"));
  const jobRoot = path.join(root, JOB_ID);
  await mkdir(jobRoot, { recursive: true });
  const previous = Object.fromEntries(["JOBS_ROOT", ...Object.keys(AUTH_ENV)].map((name) => [name, process.env[name]]));
  Object.assign(process.env, AUTH_ENV, { JOBS_ROOT: root });
  const token = createSessionToken(AUTH_ENV, 2_000_000_000);
  const request = (id = JOB_ID, authenticated = true) => new Request(`http://local/api/jobs/${id}`, {
    headers: authenticated ? { Cookie: `potongin_session=${token}` } : {},
  });
  const invoke = (id = JOB_ID, authenticated = true) => getJobDetail(request(id, authenticated), {
    params: Promise.resolve({ id }),
  });

  try {
    const denied = await invoke(JOB_ID, false);
    const invalid = await invoke("not-a-uuid");
    const missing = await invoke("223e4567-e89b-42d3-a456-426614174000");
    await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({ id: JOB_ID, clips: [] }));
    const success = await invoke();
    await writeFile(path.join(jobRoot, "job.json"), "not json");
    const failed = await invoke();

    assert.deepEqual([denied.status, invalid.status, missing.status, success.status, failed.status], [401, 400, 404, 200, 500]);
    for (const response of [denied, invalid, missing, success, failed]) {
      assert.equal(response.headers.get("Cache-Control"), "no-store");
    }
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("buildCandidateView sorts a copied candidate list by DTO displayOrder", () => {
  const input = [candidate(), candidate({ id: "candidate-2", displayOrder: 1, rank: 2 })];
  const result = buildCandidateView({ available: true, candidates: input });
  assert.deepEqual(result.candidates.map((item) => item.id), ["candidate-2", "candidate-1"]);
  assert.deepEqual(input.map((item) => item.id), ["candidate-1", "candidate-2"]);
});

test("buildCandidateView falls back to unavailable for absent or malformed DTOs", () => {
  assert.deepEqual(buildCandidateView({ available: false, candidates: [] }), { available: false, selectionVersion: "", candidates: [] });
  assert.deepEqual(buildCandidateView({ available: true, candidates: "private-path" }), { available: false, selectionVersion: "", candidates: [] });
});

test("feedback view maps only valid latest candidate decisions", () => {
  const view = buildFeedbackView({
    available: true,
    selectionVersion: "selection-v2.0",
    eventCount: 4,
    latestByCandidate: {
      "candidate-1": { candidateId: "candidate-1", decision: "accepted", note: "Pembuka kuat", createdAt: "2026-08-30T10:00:00Z" },
      mismatch: { candidateId: "other", decision: "rejected", note: "", createdAt: "2026-08-30T10:01:00Z" },
      invalid: { candidateId: "invalid", decision: "maybe", note: "", createdAt: "2026-08-30T10:02:00Z" },
    },
  });

  assert.equal(view.available, true);
  assert.equal(view.selectionVersion, "selection-v2.0");
  assert.equal(view.eventCount, 4);
  assert.deepEqual(Object.keys(view.latestByCandidate), ["candidate-1"]);
  assert.equal(view.latestByCandidate["candidate-1"].decision, "accepted");
  assert.equal(buildFeedbackView({ created: true, state: { ...view, eventCount: 5 } }).eventCount, 5);
  assert.deepEqual(buildFeedbackView(null), { available: false, selectionVersion: "", eventCount: 0, latestByCandidate: {} });
});

test("feedback payload validation enforces contract fields and note limit", () => {
  const valid = { candidateId: "candidate-1", decision: "undecided", note: "", clientRequestId: "123e4567-e89b-42d3-a456-426614174000" };
  assert.deepEqual(validateFeedbackPayload(valid), { valid: true, error: "" });
  assert.equal(validateFeedbackPayload({ ...valid, decision: "maybe" }).valid, false);
  assert.equal(validateFeedbackPayload({ ...valid, note: "x".repeat(501) }).valid, false);
  assert.equal(validateFeedbackPayload({ ...valid, clientRequestId: "retry-1" }).valid, false);
});

test("feedback notes count Unicode scalars and reject every control character", () => {
  const valid = { candidateId: "candidate-1", decision: "undecided", note: "", clientRequestId: "123e4567-e89b-42d3-a456-426614174000" };
  assert.equal(validateFeedbackPayload({ ...valid, note: "😀".repeat(500) }).valid, true);
  assert.match(validateFeedbackPayload({ ...valid, note: "😀".repeat(501) }).error, /500/);
  for (const note of ["baris\nbaru", "kolom\tbaru", "nul\0byte", `kontrol-${String.fromCodePoint(0x7f)}`]) {
    assert.match(validateFeedbackPayload({ ...valid, note }).error, /karakter kontrol|baris baru/i);
  }
  const rawNote = "\nakan terpangkas";
  const attempt = createFeedbackSaveAttempt(null, { ...valid, note: rawNote }, () => valid.clientRequestId);
  assert.match(validateFeedbackPayload({ ...attempt, note: rawNote }).error, /karakter kontrol|baris baru/i);
});

test("feedback save attempt reuses an id only for an identical retryable payload", () => {
  const ids = ["123e4567-e89b-42d3-a456-426614174000", "223e4567-e89b-42d3-a456-426614174000"];
  const uuid = () => ids.shift();
  const payload = { candidateId: "candidate-1", decision: "accepted", note: "Layak dievaluasi" };
  const first = createFeedbackSaveAttempt(null, payload, uuid);
  const retry = createFeedbackSaveAttempt({ ...first, retryable: true }, payload, uuid);
  const changed = createFeedbackSaveAttempt({ ...first, retryable: true }, { ...payload, note: "Catatan baru" }, uuid);

  assert.equal(first.clientRequestId, "123e4567-e89b-42d3-a456-426614174000");
  assert.equal(retry.clientRequestId, first.clientRequestId);
  assert.equal(changed.clientRequestId, "223e4567-e89b-42d3-a456-426614174000");
});

test("feedback save attempts trim notes before payload comparison and submission", () => {
  const id = "123e4567-e89b-42d3-a456-426614174000";
  const payload = { candidateId: "candidate-1", decision: "accepted", note: "  Layak  " };
  const first = createFeedbackSaveAttempt(null, payload, () => id);
  const retry = createFeedbackSaveAttempt({ ...first, retryable: true }, { ...payload, note: "Layak" }, () => assert.fail("should reuse ID"));
  assert.equal(first.note, "Layak");
  assert.equal(retry.clientRequestId, id);
});

test("feedback failures follow fixed backend codes and preserve safe retry semantics", () => {
  const changed = classifyFeedbackSaveFailure(409, { code: "selection_changed", error: "changed" });
  assert.equal(changed.reloadRequired, true);
  assert.equal(changed.retryable, false);
  assert.match(changed.message, /muat ulang/i);

  const conflict = classifyFeedbackSaveFailure(409, { code: "idempotency_conflict", error: "conflict" });
  assert.equal(conflict.reloadRequired, false);
  assert.equal(conflict.retryable, false);
  assert.equal(conflict.clearPending, true);
  assert.doesNotMatch(conflict.message, /versi kandidat/i);
  assert.match(conflict.message, /ID permintaan|coba simpan lagi/i);

  const invalidArtifact = classifyFeedbackSaveFailure(422, { code: "invalid_artifact" });
  assert.equal(invalidArtifact.reloadRequired, true);
  assert.match(invalidArtifact.message, /muat ulang/i);

  const unavailable = classifyFeedbackSaveFailure(503, { code: "backend_unavailable" });
  assert.equal(unavailable.retryable, true);
  assert.equal(unavailable.clearPending, false);
  const retry = createFeedbackSaveAttempt(
    { candidateId: "candidate-1", decision: "accepted", note: "Bagus", clientRequestId: "123e4567-e89b-42d3-a456-426614174000", retryable: unavailable.retryable },
    { candidateId: "candidate-1", decision: "accepted", note: "Bagus" },
    () => assert.fail("503 retry must reuse the request ID"),
  );
  assert.equal(retry.clientRequestId, "123e4567-e89b-42d3-a456-426614174000");

  const invalid = classifyFeedbackSaveFailure(400, { code: "invalid_request", error: "bad" });
  assert.equal(invalid.retryable, false);
  assert.equal(invalid.clearPending, true);

  const unknown = classifyFeedbackSaveFailure(409, { code: "something_new", error: "misleading server detail" });
  assert.equal(unknown.reloadRequired, false);
  assert.match(unknown.message, /tidak dapat disimpan/i);
  assert.doesNotMatch(unknown.message, /misleading/);
});

test("feedback view accepts the actual PUT response envelope", () => {
  const item = { candidateId: "candidate-1", decision: "accepted", note: "Bagus", createdAt: "2026-08-30T10:00:00Z" };
  const view = buildFeedbackView({
    created: true,
    event: { ...item, eventId: "223e4567-e89b-42d3-a456-426614174000", clientRequestId: "123e4567-e89b-42d3-a456-426614174000" },
    state: { available: true, selectionVersion: "selection-v2.0", eventCount: 1, latestByCandidate: { "candidate-1": item } },
  });
  assert.equal(view.available, true);
  assert.equal(view.eventCount, 1);
  assert.deepEqual(view.latestByCandidate["candidate-1"], item);
});

test("candidate unauthorized wins over a rejected job request", async () => {
  const result = await loadProjectDetail(JOB_ID, {
    fetchImpl: async (url) => {
      if (url.endsWith("/candidates")) return Response.json({ error: "expired" }, { status: 401 });
      throw new Error("job network failure");
    },
  });

  assert.deepEqual(result, {
    type: "redirect",
    location: `/login?next=${encodeURIComponent(`/projects/${JOB_ID}`)}`,
  });
});

test("project detail loader passes one abort signal to all requests and returns presentation state", async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await loadProjectDetail(JOB_ID, {
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/candidate-feedback")) {
        return Response.json({ available: true, selectionVersion: "selection-v2.0", eventCount: 1, latestByCandidate: {} });
      }
      if (url.endsWith("/candidates")) {
        return Response.json({ available: true, selectionVersion: "selection-v2.0", candidates: [candidate()] });
      }
      return Response.json({ job: { id: JOB_ID, clips: [] } });
    },
  });

  assert.equal(calls.length, 3);
  assert.ok(calls.every(({ options }) => options.signal === controller.signal && options.cache === "no-store"));
  assert.equal(result.type, "loaded");
  assert.equal(result.job.id, JOB_ID);
  assert.deepEqual(result.candidateView.candidates.map((item) => item.id), ["candidate-1"]);
  assert.equal(result.feedbackView.eventCount, 1);
  assert.equal(result.candidateNotice, "");
  assert.equal(result.feedbackNotice, "");
});

test("feedback 404 is empty while feedback failures stay nonblocking", async () => {
  const loadWithFeedback = (feedbackResponse) => loadProjectDetail(JOB_ID, {
    fetchImpl: async (url) => {
      if (url.endsWith("/candidate-feedback")) return feedbackResponse;
      if (url.endsWith("/candidates")) return Response.json({ available: true, selectionVersion: "selection-v2.0", candidates: [candidate()] });
      return Response.json({ job: { id: JOB_ID, clips: [{ index: 1 }] } });
    },
  });

  const missing = await loadWithFeedback(Response.json({ error: "missing" }, { status: 404 }));
  assert.equal(missing.feedbackView.available, false);
  assert.equal(missing.feedbackNotice, "");
  assert.equal(missing.job.clips.length, 1);

  const failed = await loadWithFeedback(Response.json({ error: "storage offline" }, { status: 503 }));
  assert.equal(failed.feedbackView.available, false);
  assert.match(failed.feedbackNotice, /feedback/i);
  assert.equal(failed.candidateView.candidates.length, 1);
});

test("feedback unauthorized has redirect priority over other failures", async () => {
  const result = await loadProjectDetail(JOB_ID, {
    fetchImpl: async (url) => {
      if (url.endsWith("/candidate-feedback")) return Response.json({}, { status: 401 });
      if (url.endsWith("/candidates")) throw new Error("candidate network failure");
      throw new Error("job network failure");
    },
  });
  assert.equal(result.type, "redirect");
});

test("candidate display formatters remain honest and locale-friendly", () => {
  assert.equal(formatDuration(65.25), "1:05.3");
  assert.equal(formatDuration(Number.NaN), "—");
  assert.equal(formatScore(7.25), "7,3");
  assert.equal(profileLabel("viral-short"), "Klip singkat");
  assert.equal(profileLabel("unknown"), "Profil kandidat");
});

test("project detail source has accessible states and no candidate media URL construction", async () => {
  const source = await readFile(new URL("../app/projects/[id]/page.jsx", import.meta.url), "utf8");
  const helperSource = await readFile(new URL("../lib/candidate-view.mjs", import.meta.url), "utf8");
  assert.match(helperSource, /\/api\/jobs\/\$\{id\}/);
  assert.match(helperSource, /\/api\/jobs\/\$\{id\}\/candidates/);
  assert.match(helperSource, /cache:\s*"no-store"/);
  assert.match(helperSource, /Promise\.allSettled/);
  assert.match(source, /const controller = new AbortController\(\)/);
  assert.match(source, /let active = true/);
  assert.match(source, /loadProjectDetail\(id, \{ signal: controller\.signal \}\)/);
  assert.match(source, /if \(!active\) return/);
  assert.match(source, /active = false;\s*controller\.abort\(\)/);
  assert.match(source, /error\?\.name === "AbortError"/);
  assert.match(source, /aria-live="polite"/);
  assert.match(source, /<fieldset/);
  assert.match(source, /<legend/);
  assert.match(source, /type="radio"/);
  assert.match(source, /Accept/);
  assert.match(source, /Tolak/);
  assert.match(source, /Belum diputuskan/);
  assert.match(source, /Array\.from\(note\)\.length/);
  assert.doesNotMatch(source, /maxLength=\{500\}/);
  assert.match(source, /feedback tersimpan untuk evaluasi\/kalibrasi mendatang/i);
  assert.match(source, /segmen transkrip utuh/i);
  assert.match(source, /crypto\.randomUUID/);
  assert.match(source, /onReloadRequired\(failure\.message\)/);
  assert.match(source, /onFeedbackReloadRequired=\{setFeedbackReloadRequired\}/);
  assert.match(source, /feedbackEnabled=\{selectionVersionMatches && !feedbackReloadRequired\}/);
  assert.match(source, /role="progressbar"/);
  assert.match(source, /Clip Potential Score/);
  assert.match(source, /V2 shadow/);
  assert.match(source, /sinyal aktivitas/);
  assert.match(source, /<details/);
  assert.doesNotMatch(source, /sourcePath|candidates\.v2\.json|\/data\/jobs|candidate\.videoUrl/);
});

test("project history links each card to its detail route", async () => {
  const source = await readFile(new URL("../app/projects/page.jsx", import.meta.url), "utf8");
  assert.match(source, /href={`\/projects\/\$\{job\.id\}`}/);
});

test("rendered clips omit invalid HTML SRT tracks but retain an explained SRT download", async () => {
  const source = await readFile(new URL("../app/projects/[id]/page.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<track\b/);
  assert.match(source, /href=\{clip\.subtitleUrl\}>Subtitle SRT ↓<\/a>/);
  assert.match(source, /Subtitle SRT tersedia sebagai file unduhan/);
});

test("candidate metadata stays at least 12px and contribution annotations use accessible contrast", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const finalDeclaration = (selector, property) => {
    let value = null;
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!match[1].split(",").map((item) => item.trim()).includes(selector)) continue;
      const declaration = match[2].match(new RegExp(`${property}:([^;]+)`));
      if (declaration) value = declaration[1].trim();
    }
    return value;
  };
  const pixels = (value) => value?.endsWith("rem") ? Number.parseFloat(value) * 16 : Number.parseFloat(value);
  const metadata = [
    ".candidateRank span", ".candidateScore>span", ".candidateTitle>div",
    ".candidatePanel .eyebrow", ".candidatePanel>header>strong",
    ".candidateScore strong small", ".candidateTiming small", ".boundaryNote",
    ".topicTerms span", ".candidateCard h4", ".candidateColumns section>p",
    ".featureGrid dt", ".featureGrid dd", ".mediaSignals dt", ".mediaSignals dd",
    ".mediaSignals p", ".scoreDetails summary", ".breakdownSummary span",
    ".contributions>div", ".contributions small",
  ];

  for (const selector of metadata) {
    assert.ok(pixels(finalDeclaration(selector, "font-size")) >= 12, `${selector} must be at least 12px`);
  }
  assert.equal(finalDeclaration(".contributions small", "color"), "#a8ad9f");
});
