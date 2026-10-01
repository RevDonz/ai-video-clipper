// The Python side of QG-SEC (plan §9.1 "Python re-validates everything", §10.2; T4.2), run on the
// real interpreter: every editor CLI re-checks its ids (job, clip, render, task, asset, incoming
// upload, idempotency key) and refuses path-traversal values without touching the filesystem or
// echoing a path, and the AI CLI refuses a request that is not exactly {task, doc}.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ROUTE_PARAMS } from "../lib/security-headers.mjs";
import { CLIP, JOB, REPO, RENDER, SHA, TASK } from "./security-support.mjs";

function python() {
  const configured = process.env.PYTHON_BIN;
  if (configured) return configured.includes(path.sep) ? path.resolve(configured) : configured;
  return path.join(REPO, ".venv", "bin", "python");
}

function runPython(code, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(python(), ["-c", code, ...args], {
      stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: os.tmpdir(), PYTHONPATH: path.join(REPO, "src") },
    });
    const out = [];
    const err = [];
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
      else reject(new Error(`python exited ${code}: ${Buffer.concat(err).toString("utf8").slice(-2000)}`));
    });
    child.stdin.end(input);
  });
}

// One interpreter runs every case in process: {module, op, envelope} → {code, payload}.
const DRIVER = String.raw`
import importlib, json, sys
root = sys.argv[1]
out = []
for case in json.load(sys.stdin):
    module = importlib.import_module(case["module"])
    raw = case["raw"].encode("utf-8") if "raw" in case else json.dumps({"op": case["op"], **case["envelope"]}).encode("utf-8")
    if case["module"] == "ai_clipper.render_queue":
        code, payload = module.handle_v3(raw, jobs_root=root)
    elif case["module"] == "ai_clipper.editor_ai":
        code, payload = module.handle(raw, jobs_root=root, env={})
    else:
        code, payload = module.handle(raw, jobs_root=root)
    out.append({"code": code, "payload": json.dumps(payload, ensure_ascii=False)})
print(json.dumps(out))
`;

const B64_DOC = Buffer.from("{}").toString("base64");
const KEY = "00000000-0000-4000-8000-000000000009";
const BASES = [
  ["ai_clipper.edit_v2.api", "clips", { jobId: JOB }],
  ["ai_clipper.edit_v2.api", "prepare_job", { jobId: JOB }],
  ["ai_clipper.edit_v2.api", "get", { jobId: JOB, clipId: CLIP }],
  ["ai_clipper.edit_v2.api", "seed", { jobId: JOB, clipId: CLIP }],
  ["ai_clipper.edit_v2.api", "put", { jobId: JOB, clipId: CLIP, expectedEtag: SHA, idempotencyKey: KEY, docRaw: B64_DOC }],
  ["ai_clipper.edit_v2.preview_cli", "prepare", { jobId: JOB, clipId: CLIP, layout: null }],
  ["ai_clipper.edit_v2.preview_cli", "plan", { jobId: JOB, clipId: CLIP, requestRaw: B64_DOC }],
  ["ai_clipper.edit_v2.preview_cli", "frame", { jobId: JOB, clipId: CLIP, requestRaw: B64_DOC, cancelToken: null }],
  ["ai_clipper.edit_v2.preview_cli", "derive", { jobId: JOB, clipId: CLIP, asset: `sha256:${SHA}`, w: 10, h: 10, opacityPm: 1000, cancelToken: null }],
  ["ai_clipper.edit_v2.assets", "ingest", { jobId: JOB, incomingId: KEY, kind: "logo", mime: "image/png", name: null, idempotencyKey: KEY }],
  ["ai_clipper.edit_v2.assets", "meta", { jobId: JOB, sha256: SHA }],
  ["ai_clipper.edit_v2.cleanup", "list", { jobId: JOB, clipId: CLIP }],
  ["ai_clipper.edit_v2.coldopen", "list", { jobId: JOB, clipId: CLIP }],
  ["ai_clipper.editor_ai", "heuristic", { jobId: JOB, clipId: CLIP, requestRaw: B64_DOC }],
  ["ai_clipper.editor_ai", "run-task", { jobId: JOB, clipId: CLIP, taskId: TASK, requestRaw: B64_DOC }],
  ["ai_clipper.render_queue", "estimate", { jobId: JOB, clipId: CLIP, editEtag: SHA }],
  ["ai_clipper.render_queue", "create", { jobId: JOB, clipId: CLIP, editEtag: SHA, idempotencyKey: KEY }],
  ["ai_clipper.render_queue", "get", { jobId: JOB, renderId: RENDER }],
  ["ai_clipper.render_queue", "cancel", { jobId: JOB, renderId: RENDER }],
  ["ai_clipper.render_queue", "list", { jobId: JOB, clipId: CLIP }],
];
const ID_FIELDS = ["jobId", "clipId", "taskId", "renderId", "incomingId", "idempotencyKey", "sha256", "expectedEtag", "editEtag"];

function traversal(valid) {
  return ["..", "../..", `../${valid}`, `${valid}/..`, `${valid}/../../secret.txt`, "../../secret.txt", `/${valid}`,
    `${valid}\u0000`, `${valid}\n`, ` ${valid}`, "", `${valid.slice(0, -1)}/`, "%2e%2e%2f%2e%2e", `..\\..\\secret.txt`];
}

async function fixture(t) {
  const top = await mkdtemp(path.join(os.tmpdir(), "potongin-sec-py-"));
  t.after(() => rm(top, { recursive: true, force: true }));
  const root = path.join(top, "jobs");
  await mkdir(path.join(root, JOB, "analysis", "clips", CLIP), { recursive: true });
  await writeFile(path.join(top, "secret.txt"), "canary-python-outside-root");
  return { top, root };
}

async function tree(dir) {
  const out = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      out.push(path.relative(dir, full));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(dir);
  return out.sort();
}

test("Node and Python agree on the id shapes, and both refuse every traversal value", async () => {
  const VALID = { job: JOB, clip: CLIP, task: TASK, render: RENDER, sha: SHA, key: KEY };
  const vectors = {};
  for (const [kind, valid] of Object.entries(VALID)) vectors[kind] = [valid, ...traversal(valid), valid.toUpperCase()];
  const code = String.raw`
import json, sys
from ai_clipper.edit_v2 import api, assets, cleanup, coldopen, preview_cli, store
from ai_clipper.edit_v2.clip_id import CLIP_ID_PATTERN
from ai_clipper import editor_ai, render_queue
patterns = {
  "job": [api._UUID, preview_cli._UUID, assets._UUID, cleanup._UUID, coldopen._UUID, editor_ai._UUID, render_queue._V3_UUID],
  "clip": [CLIP_ID_PATTERN],
  "task": [editor_ai._UUID],
  "render": [render_queue._V3_UUID],
  "sha": [api._SHA, assets._SHA, preview_cli._HEX64, render_queue._SHA],
  "key": [store._KEY, assets._UUID, render_queue._V3_UUID],
}
vectors = json.load(sys.stdin)
print(json.dumps({kind: [[p.fullmatch(v) is not None for p in patterns[kind]] for v in vectors[kind]] for kind in patterns}))
`;
  const python = JSON.parse(await runPython(code, [], JSON.stringify(vectors)));
  const node = { job: ROUTE_PARAMS.id, clip: ROUTE_PARAMS.clipId, task: ROUTE_PARAMS.taskId, render: ROUTE_PARAMS.renderId,
    sha: ROUTE_PARAMS.sha, key: ROUTE_PARAMS.idempotencyKey };
  for (const [kind, values] of Object.entries(vectors)) {
    values.forEach((value, index) => {
      const label = `${kind} ${JSON.stringify(value)}`;
      const nodeAccepts = node[kind].test(value);
      if (index === 0) {
        assert.ok(nodeAccepts, `${label}: Node accepts the valid id`);
        assert.ok(python[kind][index].every(Boolean), `${label}: every Python pattern accepts the valid id`);
      } else if (index === values.length - 1) {
        // upper case: Node refuses (one spelling per id); Python may accept it (no path effect)
        assert.equal(nodeAccepts, value === VALID[kind], `${label}: Node refuses another spelling`);
      } else {
        assert.equal(nodeAccepts, false, `${label}: Node refuses it`);
        assert.ok(python[kind][index].every((accepted) => !accepted), `${label}: every Python pattern refuses it`);
      }
    });
  }
});

test("every editor CLI refuses traversal ids in its envelope: no file touched, no path echoed", async (t) => {
  const { top, root } = await fixture(t);
  const before = await tree(top);
  const cases = [];
  for (const [module, op, base] of BASES) {
    for (const field of ID_FIELDS.filter((name) => Object.hasOwn(base, name))) {
      for (const value of traversal(base[field])) cases.push({ module, op, envelope: { ...base, [field]: value }, field, value });
    }
  }
  const results = JSON.parse(await runPython(DRIVER, [root], JSON.stringify(cases.map(({ module, op, envelope }) => ({ module, op, envelope })))));
  assert.equal(results.length, cases.length);
  results.forEach((result, index) => {
    const { module, op, field, value } = cases[index];
    const label = `${module} ${op} ${field}=${JSON.stringify(value)}`;
    assert.ok([2, 3, 4].includes(result.code), `${label}: exit ${result.code}`);
    for (const needle of [top, root, "canary-python-outside-root", "Traceback"]) {
      assert.ok(!result.payload.includes(needle), `${label}: the answer carries ${needle}`);
    }
  });
  assert.deepEqual(await tree(top), before, "nothing was created or removed");
});

test("the AI CLI refuses any request that is not exactly {task: \"hooks\", doc}", async (t) => {
  const { root } = await fixture(t);
  const doc = '{"schema":"clip-edit-v2"}';
  const bodies = [
    `{"task":"hooks","doc":${doc},"provider":"openai"}`,
    `{"task":"hooks","doc":${doc},"model":"x"}`,
    `{"task":"hooks","doc":${doc},"baseUrl":"http://127.0.0.1:9"}`,
    `{"task":"hooks","doc":${doc},"doc":${doc}}`,
    `{"task":"hooks","task":"hooks","doc":${doc}}`,
    `{"task":"titles","doc":${doc}}`,
    `{"doc":${doc}}`,
    `{"task":"hooks","doc":${doc},"__proto__":{}}`,
  ];
  const cases = bodies.flatMap((body) => ["heuristic", "run-task"].map((op) => ({
    module: "ai_clipper.editor_ai", op,
    envelope: { jobId: JOB, clipId: CLIP, requestRaw: Buffer.from(body).toString("base64"), ...(op === "run-task" ? { taskId: TASK } : {}) },
  })));
  const results = JSON.parse(await runPython(DRIVER, [root], JSON.stringify(cases)));
  results.forEach((result, index) => {
    assert.notEqual(result.code, 0, `${cases[index].op} ${bodies[Math.floor(index / 2)]}`);
    const payload = JSON.parse(result.payload);
    assert.ok(!payload.suggestions?.length && !payload.heuristic?.length, "no suggestion for a refused request");
  });
});

test("an envelope with an extra or doubled member is a usage error in every CLI", async (t) => {
  const { root } = await fixture(t);
  const cases = [];
  for (const [module, op, base] of BASES) {
    cases.push({ module, op, envelope: { ...base, path: "/etc/passwd" } });
    const fields = Object.entries({ op, ...base }).map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`);
    cases.push({ module, raw: `{${fields.join(",")},"jobId":"${JOB}"}` });
  }
  const results = JSON.parse(await runPython(DRIVER, [root], JSON.stringify(cases)));
  results.forEach((result, index) => {
    const label = `${cases[index].module} ${cases[index].op ?? "doubled jobId"}`;
    assert.equal(result.code, 2, `${label}: exit ${result.code}`);
  });
});
