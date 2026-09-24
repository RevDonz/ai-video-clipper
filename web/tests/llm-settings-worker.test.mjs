import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { saveLlmSettings } from "../lib/llm-settings.mjs";
import { claimNextJob } from "../lib/primary-job-queue.mjs";
import { downloaderEnv, main } from "../scripts/run-job.mjs";

const JOB_ID = "a23e4567-e89b-42d3-a456-426614174111";
const V3 = { renderMode: "fit-blur", limit: 3, minDuration: 20, maxDuration: 60, selectionMode: "v3", llmMode: "auto", coldOpen: true, hookOverlay: true, captionStyle: "karaoke" };
const SECRET = "worker-session-secret-".padEnd(48, "w");
const HERMES_KEY = "hermes-worker-key-5555aaaa";

const FAKE_ENGINE = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const output = arg("--output-dir");
await mkdir(output, { recursive: true });
await mkdir(path.join(arg("--artifact-root"), "analysis"), { recursive: true });
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /POTONGIN|API_KEY|^APP_/.test(name)));
await writeFile(process.env.ENGINE_LOG, JSON.stringify(env));
await writeFile(path.join(output, "manifest.json"), JSON.stringify({
  status: "completed",
  clips: [{ index: 1, score: 8, start: 1, end: 30, duration: 29, text: "Halo", output: path.join(output, "clip-01.mp4"), subtitles: path.join(output, "clip-01.srt"), title: "Judul", description: "Deskripsi", hashtags: ["#a"] }],
}));
`;

const FAKE_YT_DLP = `#!/usr/bin/env node
import { appendFile, writeFile } from "node:fs/promises";
const argv = process.argv.slice(2);
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => /POTONGIN|API_KEY|^APP_/.test(name)));
await appendFile(process.env.YT_DLP_LOG, JSON.stringify(env) + "\\n");
if (!argv.includes("--skip-download")) {
  await writeFile(argv[argv.indexOf("--output") + 1].replace("%(ext)s", "mp4"), Buffer.alloc(32));
}
`;

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "llm-worker-"));
  const jobsRoot = path.join(root, "jobs");
  const jobRoot = path.join(jobsRoot, JOB_ID);
  await mkdir(path.join(jobRoot, "input"), { recursive: true });
  await writeFile(path.join(jobRoot, "job.json"), JSON.stringify({
    id: JOB_ID, status: "queued", progress: 0, createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z",
    source: { type: "youtube", url: "https://youtu.be/abc" }, sourcePath: null, options: V3, clips: [],
  }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "engine.mjs"), FAKE_ENGINE);
  await writeFile(path.join(bin, "yt-dlp"), FAKE_YT_DLP);
  await chmod(path.join(bin, "engine.mjs"), 0o755);
  await chmod(path.join(bin, "yt-dlp"), 0o755);
  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`, HOME: process.env.HOME || root,
    JOBS_ROOT: jobsRoot, PRIMARY_LEASE_MS: "60000", AI_CLIPPER_BIN: path.join(bin, "engine.mjs"),
    ENGINE_LOG: path.join(root, "engine.json"), YT_DLP_LOG: path.join(root, "yt-dlp.log"),
    APP_USERNAME: "admin", APP_PASSWORD: "worker-password", APP_SESSION_SECRET: SECRET,
    POTONGIN_LLM_PROVIDERS: "gemini", GEMINI_API_KEY: "inherited-gemini-key", POTONGIN_LLM_MODEL: "inherited-model",
  };
  return { root, jobsRoot, jobRoot, env };
}

async function runJob({ jobsRoot, env }) {
  const claim = await claimNextJob({ jobsRoot, workerId: "worker", leaseMs: 60_000, maxAttempts: 3, legacyQuiescenceMs: 0 });
  await main(["node", "run-job.mjs", JOB_ID, claim.token], env);
}

test("the engine runs with the saved UI settings; yt-dlp never sees a key or a secret", async () => {
  const { root, jobsRoot, jobRoot, env } = await fixture();
  await saveLlmSettings({
    enabled: true, freeOnly: true,
    providers: [
      { provider: "custom", enabled: true, baseUrl: "https://hermes.example/v1", model: "LJNAI-FAST", reasoningEffort: "none", apiKey: { action: "replace", value: HERMES_KEY } },
      { provider: "ollama-cloud", enabled: false },
    ],
  }, { env });
  await runJob({ jobsRoot, env });

  const persisted = JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8"));
  assert.equal(persisted.status, "completed", persisted.error);
  const engine = JSON.parse(await readFile(path.join(root, "engine.json"), "utf8"));
  assert.equal(engine.POTONGIN_LLM, "on");
  assert.equal(engine.POTONGIN_LLM_PROVIDERS, "custom");
  assert.equal(engine.POTONGIN_LLM_FREE_ONLY, "1");
  assert.equal(engine.POTONGIN_LLM_CUSTOM_API_KEY, HERMES_KEY);
  assert.equal(engine.POTONGIN_LLM_CUSTOM_REASONING_EFFORT, "none");
  assert.equal(engine.GEMINI_API_KEY, undefined, "inherited provider keys are dropped");
  assert.equal(engine.POTONGIN_LLM_MODEL, undefined, "inherited LLM variables are dropped");
  assert.equal(engine.APP_SESSION_SECRET, undefined, "the engine never gets the key-sealing secret");
  assert.equal(engine.APP_PASSWORD, undefined);

  const downloads = (await readFile(path.join(root, "yt-dlp.log"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(downloads.length >= 1);
  for (const seen of downloads) {
    assert.deepEqual(Object.keys(seen).filter((name) => name !== "APP_USERNAME"), [], "yt-dlp gets no LLM variable, key or secret");
  }
  assert.doesNotMatch(await readFile(path.join(jobRoot, "job.json"), "utf8"), /hermes-worker-key|inherited-gemini-key/);
});

test("without a settings file the engine keeps the environment configuration", async () => {
  const { root, jobsRoot, jobRoot, env } = await fixture();
  await runJob({ jobsRoot, env });
  assert.equal(JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8")).status, "completed");
  const engine = JSON.parse(await readFile(path.join(root, "engine.json"), "utf8"));
  assert.equal(engine.POTONGIN_LLM_PROVIDERS, "gemini");
  assert.equal(engine.GEMINI_API_KEY, "inherited-gemini-key");
  assert.equal(engine.APP_SESSION_SECRET, undefined);
});

test("a corrupt settings file switches the LLM off for the job instead of using .env", async () => {
  const { root, jobsRoot, jobRoot, env } = await fixture();
  await mkdir(path.join(root, "settings"), { recursive: true });
  await writeFile(path.join(root, "settings", "llm-settings.json"), "{ not json");
  await runJob({ jobsRoot, env });
  assert.equal(JSON.parse(await readFile(path.join(jobRoot, "job.json"), "utf8")).status, "completed");
  const engine = JSON.parse(await readFile(path.join(root, "engine.json"), "utf8"));
  assert.equal(engine.POTONGIN_LLM, "off");
  assert.equal(engine.GEMINI_API_KEY, undefined);
});

test("the downloader environment drops every LLM variable and dashboard secret", () => {
  assert.deepEqual(downloaderEnv({
    PATH: "/bin", POTONGIN_LLM: "on", POTONGIN_LLM_PROVIDERS: "custom", POTONGIN_LLM_CUSTOM_API_KEY: "k", OLLAMA_API_KEY: "k",
    POTONGIN_SETTINGS_SECRET: "s", POTONGIN_SETTINGS_DIR: "/data/settings", APP_SESSION_SECRET: "s", APP_PASSWORD: "p",
    POTONGIN_CAPTIONS_TIMEOUT_MS: "5000",
  }), { PATH: "/bin", POTONGIN_CAPTIONS_TIMEOUT_MS: "5000" });
});
