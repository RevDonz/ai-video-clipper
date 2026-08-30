import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GET as getJobDetail } from "../app/api/jobs/[id]/route.js";
import { createSessionToken } from "../lib/auth.mjs";
import {
  buildCandidateView,
  formatDuration,
  formatScore,
  loadProjectDetail,
  profileLabel,
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
  assert.deepEqual(buildCandidateView({ available: false, candidates: [] }), { available: false, candidates: [] });
  assert.deepEqual(buildCandidateView({ available: true, candidates: "private-path" }), { available: false, candidates: [] });
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

test("project detail loader passes one abort signal to both requests and returns presentation state", async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await loadProjectDetail(JOB_ID, {
    signal: controller.signal,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/candidates")) {
        return Response.json({ available: true, candidates: [candidate()] });
      }
      return Response.json({ job: { id: JOB_ID, clips: [] } });
    },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls.every(({ options }) => options.signal === controller.signal && options.cache === "no-store"));
  assert.equal(result.type, "loaded");
  assert.equal(result.job.id, JOB_ID);
  assert.deepEqual(result.candidateView.candidates.map((item) => item.id), ["candidate-1"]);
  assert.equal(result.candidateNotice, "");
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
