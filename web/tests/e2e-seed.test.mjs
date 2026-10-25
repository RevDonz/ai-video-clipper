// The completed project the CI run of the production read-only specs seeds
// (scripts/seed-e2e-project.mjs, editor-gates.yml -f seed=true): the real routes list it as the
// newest completed project with clips, serve its clip files, and the editor listing answers for it
// (the specs fail on any API answer of 400 or more).
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { GET as listJobs } from "../app/api/jobs/route.js";
import { GET as getJob } from "../app/api/jobs/[id]/route.js";
import { GET as getClips } from "../app/api/jobs/[id]/clips/route.js";
import { GET as getFile } from "../app/api/jobs/[id]/files/[...path]/route.js";
import { createSessionToken } from "../lib/auth.mjs";
import { E2E_JOB_ID, seedE2eProject } from "../scripts/seed-e2e-project.mjs";

const WEB = fileURLToPath(new URL("..", import.meta.url));
const ENV = {
  APP_USERNAME: "e2e",
  APP_PASSWORD: "seeded-run-password",
  APP_SESSION_SECRET: "a-long-random-session-secret-for-the-seed-test",
  // As the CI server runs (editor-gates.yml): the editor on, so the project page lists the clips.
  POTONGIN_EDITOR_V3: "on",
  PYTHON_BIN: process.env.PYTHON_BIN || path.join(WEB, "..", ".venv", "bin", "python"),
};

async function withSeed(t, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "potongin-e2e-seed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...ENV, JOBS_ROOT: root, POTONGIN_SETTINGS_DIR: `${root}-settings` };
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) value === undefined ? delete process.env[key] : process.env[key] = value; });
  assert.equal(await seedE2eProject(root), E2E_JOB_ID);
  const cookie = `potongin_session=${createSessionToken(env, 2_000_000_000)}`;
  const request = (url) => new Request(`http://127.0.0.1:3217${url}`, { headers: { Cookie: cookie, Host: "127.0.0.1:3217" } });
  await run({ request, params: (value) => ({ params: Promise.resolve(value) }) });
}

test("the seeded project is the newest completed project with clips, and its files and clip listing answer", async (t) => {
  await withSeed(t, async ({ request, params }) => {
    const list = await listJobs(request("/api/jobs"));
    assert.equal(list.status, 200);
    const { jobs } = await list.json();
    const target = jobs.find((job) => job.status === "completed" && Array.isArray(job.clips) && job.clips.length > 0);
    assert.equal(target?.id, E2E_JOB_ID);
    assert.equal(target.clips.length, 3);
    for (const clip of target.clips) assert.ok(clip.title && clip.videoUrl && clip.downloadUrl, JSON.stringify(clip));
    // The clip viewer shows what the landing's "Klip yang siap diunggah" picture promises: the
    // engine's packaging, the hook text and a 0-10 score.
    const second = target.clips[1];
    assert.equal(second.title, "Kamu dengar itu?");
    assert.equal(second.hookText, "Dengar baik-baik");
    assert.deepEqual(second.hashtags, ["#elephantsdream", "#blender"]);
    assert.equal(second.selectionSource, "llm");
    assert.equal(second.score, 8.4);
    assert.equal(second.scores.hook, 8.8);

    const detail = await getJob(request(`/api/jobs/${E2E_JOB_ID}`), params({ id: E2E_JOB_ID }));
    assert.equal(detail.status, 200);

    const video = await getFile(request(`/api/jobs/${E2E_JOB_ID}/files/output/clip-01.mp4`), params({ id: E2E_JOB_ID, path: ["output", "clip-01.mp4"] }));
    assert.equal(video.status, 200);
    assert.match(video.headers.get("content-type") ?? "", /^video\/mp4/);
    await video.body?.cancel();

    const clips = await getClips(request(`/api/jobs/${E2E_JOB_ID}/clips`), params({ id: E2E_JOB_ID }));
    assert.equal(clips.status, 200, await clips.clone().text());
    const listing = await clips.json();
    // A project made before the editor lists no editable clip; the page then shows no Edit klip.
    assert.ok(Array.isArray(listing.clips));
  });
});

test("editor-gates.yml seeds the project on request, before the server starts, with the editor's Python", async () => {
  const workflow = await readFile(new URL("../../.github/workflows/editor-gates.yml", import.meta.url), "utf8");
  assert.match(workflow, /\n {6}seed:\n {8}description: [^\n]+\n {8}required: false\n {8}default: false\n {8}type: boolean\n/);
  const start = workflow.slice(workflow.indexOf("- name: Start the web app on the editor fakes"), workflow.indexOf("nohup npx next start"));
  assert.match(start, /GATE_SEED: \$\{\{ inputs\.seed && '1' \|\| '' \}\}/);
  assert.match(start, /node scripts\/seed-e2e-project\.mjs "\$RUNNER_TEMP\/jobs"/);
  assert.match(start, /export PYTHON_BIN="\$RUNNER_TEMP\/editor-python\/bin\/python"/);
  assert.match(workflow, /LANDING_SHOTS: \$\{\{ contains\(inputs\.command, 'landing-shots'\) && '1' \|\| '' \}\}/);
});
