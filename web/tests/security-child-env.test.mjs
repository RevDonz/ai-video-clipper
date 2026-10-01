// E11 across every spawn site (plan §9.1 "Child processes carry no secrets", §10.2 QG-SEC; T4.2).
//
// Static: every web file that can start a process is known, with the environment it hands over.
// Dynamic: every editor route that starts Python is called with planted secrets in the app's
// environment, and each child's /proc/self/environ is read: allowlisted names only, no dashboard
// secret anywhere, and LLM keys in the AI task child alone.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isLlmVariable } from "../lib/llm-settings.mjs";
import { CHILD_ENV_ALLOWLIST, createPythonServer, childEnv } from "../lib/python-cli.mjs";
import { downloaderEnv, engineEnvironment } from "../scripts/run-job.mjs";
import {
  AUTH,
  CLIP,
  DASHBOARD_SECRETS,
  JOB,
  LLM_SECRETS,
  RENDER,
  ROUTES,
  SHA,
  STORAGE_ENV,
  WEB,
  context,
  fakePython,
  jobsRoot,
  loadRoute,
  read,
  routeRequest,
  withEnv,
} from "./security-support.mjs";

// Every web file allowed to import node:child_process, and how its children get their environment.
const SPAWN_SITES = Object.freeze({
  "lib/python-cli.mjs": /env: childEnvironment,[\s\S]*env: childEnv\(env\)/,
  "lib/render-requests.mjs": /env: childEnv\(options\.env \|\| process\.env\)/,
  "lib/llm-settings-actions.mjs": /const childEnv = engineProcessEnv\(buildLlmEnv\(settings, env, \{ only: provider \}\)\)/,
  // the primary-worker container (no APP_PASSWORD there): the runner, the engine and yt-dlp
  "scripts/primary-worker.mjs": /spawnImpl\(process\.execPath, \[runner/,
  "scripts/run-job.mjs": /processEnv: downloaderEnv\(env\)[\s\S]*await engineEnvironment\(env\)/,
  // the render-worker container: the Python render worker
  "scripts/run-render.mjs": /spawn\(command, args, \{ stdio: "inherit", shell: false, env \}\)/,
});

async function sources() {
  const files = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", "__dev__"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(?:mjs|js|jsx|cjs)$/.test(entry.name)) files.push(full);
    }
  }
  for (const dir of ["lib", "app", "components", "scripts"]) await walk(path.join(WEB, dir));
  files.push(path.join(WEB, "proxy.js"), path.join(WEB, "next.config.mjs"));
  return files;
}

test("only the known files start processes, each with its stated environment", async () => {
  const importers = [];
  for (const file of await sources()) {
    const text = await readFile(file, "utf8");
    const relative = path.relative(WEB, file).split(path.sep).join("/");
    if (/["'](?:node:)?child_process["']/.test(text) || /process\.binding\(|\bworker_threads\b/.test(text)) importers.push(relative);
    // nobody hands a child the whole environment of the app
    assert.doesNotMatch(text, /env:\s*(?:process\.env\b|\{\s*\.\.\.process\.env)/, `${relative} passes process.env to a child`);
  }
  for (const file of importers) {
    assert.ok(Object.hasOwn(SPAWN_SITES, file), `${file} starts processes but is not a known spawn site`);
    assert.match(await readFile(path.join(WEB, file), "utf8"), SPAWN_SITES[file], `${file}: the child environment rule`);
  }
  // every editor route reaches Python through python-cli.mjs only
  for (const file of ["clip-edit", "clip-renders", "editor-ai", "editor-cleanup", "coldopen-suggestions", "asset-upload",
    "preview-lane", "clip-media"]) {
    const text = await readFile(path.join(WEB, "lib", `${file}.mjs`), "utf8");
    assert.doesNotMatch(text, /child_process/, `lib/${file}.mjs spawns on its own`);
  }
});

test("the worker containers hand their children no dashboard secret", async () => {
  const settings = await mkdtemp(path.join(os.tmpdir(), "potongin-sec-worker-"));
  try {
    const env = { ...AUTH, ...DASHBOARD_SECRETS, ...LLM_SECRETS, PATH: "/usr/bin", JOBS_ROOT: "/data/jobs",
      POTONGIN_SETTINGS_DIR: settings, POTONGIN_LLM_PROVIDER: "openrouter" };
    const engine = await engineEnvironment(env, () => {});
    for (const value of Object.values(DASHBOARD_SECRETS)) assert.ok(!Object.values(engine).includes(value), "the engine holds a dashboard secret");
    const downloader = downloaderEnv(env);
    for (const value of [...Object.values(DASHBOARD_SECRETS), ...Object.values(LLM_SECRETS)]) {
      assert.ok(!Object.values(downloader).includes(value), "yt-dlp holds a secret");
    }
  } finally {
    await rm(settings, { recursive: true, force: true });
  }
});

test("the persistent preview worker starts with the allowlisted environment", async () => {
  let seen = null;
  const spawnImpl = (_bin, _args, options) => {
    seen = options.env;
    const child = new EventEmitter();
    Object.assign(child, { pid: 4242, stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter() });
    child.stdin.write = () => true;
    child.stdin.destroy = () => {};
    child.unref = () => {};
    queueMicrotask(() => child.emit("exit", 1));
    return child;
  };
  const env = { ...AUTH, ...DASHBOARD_SECRETS, ...LLM_SECRETS, PATH: "/usr/bin", JOBS_ROOT: "/data/jobs" };
  const server = createPythonServer("ai_clipper.edit_v2.preview_server", {
    cliModule: "ai_clipper.edit_v2.preview_cli", env, spawnImpl, readyTimeoutMs: 50, restartDelayMs: 60_000,
  });
  assert.equal(await server.start(), false);
  await server.close();
  assert.deepEqual(seen, childEnv(env));
  for (const name of Object.keys(seen)) assert.ok(CHILD_ENV_ALLOWLIST.includes(name), name);
});

async function waitFor(check, ms = 8000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await check()) return true;
    await new Promise((resolve) => { setTimeout(resolve, 25); });
  }
  return false;
}

test("every Python child of every editor route: allowlisted names, no dashboard secret, LLM keys only in the AI task", async (t) => {
  const fake = await fakePython(t, {
    "ai_clipper.edit_v2.api clips": { exit: 0, json: { clips: [] } },
    "ai_clipper.editor_ai heuristic": { exit: 0, json: { heuristic: [] } },
    "ai_clipper.editor_ai run-task": { exit: 0, json: {} },
    "ai_clipper.edit_v2.coldopen list": { exit: 0, json: { wordsSha256: SHA, candidates: [] } },
    "ai_clipper.render_queue estimate": { exit: 0, json: { bytes: "4096" } },
  });
  const jobs = await jobsRoot(t);
  const settings = await mkdtemp(path.join(os.tmpdir(), "potongin-sec-settings-"));
  t.after(() => rm(settings, { recursive: true, force: true }));
  // a render request for DELETE /renders/:renderId to cancel (only its id is read before the spawn)
  await writeFile(path.join(jobs.root, JOB, "analysis", "render-requests", `${RENDER}.json`), "{}");
  await mkdir(path.join(jobs.root, JOB, "analysis", "assets"), { recursive: true, mode: 0o700 });
  const env = {
    ...AUTH, ...DASHBOARD_SECRETS, ...LLM_SECRETS, ...STORAGE_ENV,
    JOBS_ROOT: jobs.root, PYTHON_BIN: fake.bin, POTONGIN_SETTINGS_DIR: settings,
    POTONGIN_EDITOR_V3: "on", POTONGIN_EDITOR_UPLOADS: "on", POTONGIN_EDITOR_LLM: "on",
    POTONGIN_PREVIEW_SERVER: "off", POTONGIN_LLM_PROVIDER: "openrouter", POTONGIN_LLM: undefined,
    FONTCONFIG_FILE: "/etc/fonts/fonts.conf", MAX_UPLOAD_BYTES: "1048576",
  };
  await withEnv(env, async () => {
    for (const route of ROUTES) {
      const handler = await loadRoute(route);
      const answer = await read(await handler(routeRequest(route).request, context(route.params)));
      assert.ok(answer.status < 500 || answer.status === 503, `${route.name}: ${answer.status}`);
    }
    const cancel = await import(path.join(WEB, "app", "api", "jobs", "[id]", "renders", "[renderId]", "route.js"));
    const request = new Request(`http://local/api/jobs/${JOB}/renders/${RENDER}`, {
      method: "DELETE", headers: { Host: "local", Origin: "http://local", "Sec-Fetch-Site": "same-origin",
        Cookie: routeRequest(ROUTES[0]).request.headers.get("cookie") },
    });
    await cancel.DELETE(request, context({ id: JOB, renderId: RENDER }));
  });
  // the LLM task runs after the 202
  assert.ok(await waitFor(async () => (await fake.records()).some((record) => record.op === "run-task")), "the AI task child ran");
  const records = await fake.records();
  const kinds = new Set(records.map((record) => `${record.module} ${record.op}`));
  for (const kind of ["ai_clipper.edit_v2.api clips", "ai_clipper.edit_v2.api prepare_job", "ai_clipper.edit_v2.api get",
    "ai_clipper.edit_v2.api put", "ai_clipper.edit_v2.preview_cli plan", "ai_clipper.edit_v2.preview_cli frame",
    "ai_clipper.edit_v2.preview_cli prepare", "ai_clipper.edit_v2.assets ingest", "ai_clipper.edit_v2.cleanup list",
    "ai_clipper.edit_v2.coldopen list", "ai_clipper.editor_ai heuristic", "ai_clipper.editor_ai run-task",
    "ai_clipper.render_queue estimate", "ai_clipper.render_queue cancel"]) {
    assert.ok(kinds.has(kind), `no ${kind} child was started (seen: ${[...kinds].sort().join(", ")})`);
  }
  const dashboard = Object.values(DASHBOARD_SECRETS);
  const llm = Object.values(LLM_SECRETS);
  for (const record of records) {
    const label = `${record.module} ${record.op}`;
    const aiTask = record.module === "ai_clipper.editor_ai" && record.op === "run-task";
    for (const name of Object.keys(record.environ)) {
      assert.ok(CHILD_ENV_ALLOWLIST.includes(name) || (aiTask && isLlmVariable(name)), `${label}: ${name} is not allowlisted`);
    }
    const values = Object.values(record.environ);
    for (const value of dashboard) assert.ok(!values.includes(value), `${label} holds a dashboard secret`);
    if (aiTask) assert.equal(record.environ.OPENROUTER_API_KEY, LLM_SECRETS.OPENROUTER_API_KEY, "the AI task holds its key");
    else for (const value of llm) assert.ok(!values.some((item) => item.includes(value)), `${label} holds an LLM key`);
    assert.equal(record.environ.JOBS_ROOT, jobs.root, label);
  }
});
