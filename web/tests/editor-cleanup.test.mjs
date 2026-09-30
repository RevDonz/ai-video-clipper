// Rapikan (plan §7.3, §11.3 T3.5): GET /api/jobs/:id/clips/:clipId/cleanup and the review model
// of the transcript panel (transcript/cleanup-model.mjs). The route cases use a recording CLI
// runner and the real `python -m ai_clipper.edit_v2.cleanup`; the model cases run the committed c30
// review list (tests/fixtures/edit_v2/cleanup-c30.json, written by cleanup.py and checked by
// pytest) against the real Appendix B commands, so "Terapkan (n)" is checked end to end.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as cleanupRouteModule from "../app/api/jobs/[id]/clips/[clipId]/cleanup/route.js";
import { FAKE_CLIP_ID, FAKE_JOB_ID, createFakeApiClient, fakeDoc, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  KIND_ORDER,
  auditionRange,
  badgeMarks,
  cleanupView,
  defaultChecked,
  normalizeListing,
  planApply,
} from "../components/editor/transcript/cleanup-model.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import { CommandRejected, applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { createEditSession } from "../lib/editor/history.mjs";
import { CLEANUP_MODULE, createCleanupRoute, sanitizeCleanup } from "../lib/editor-cleanup.mjs";
import { PythonCliError } from "../lib/python-cli.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CONTEXTS = path.join(REPO, "tests", "fixtures", "edit_v2", "docs", "contexts");
const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-secret-value", APP_SESSION_SECRET: "session-secret-".padEnd(48, "z") });

const c30 = {
  words: JSON.parse(await readFile(path.join(CONTEXTS, "c30.words.json"), "utf8")),
  seed: JSON.parse(await readFile(path.join(CONTEXTS, "c30.seed.json"), "utf8")),
};
const FIXTURE = JSON.parse(await readFile(path.join(REPO, "tests", "fixtures", "edit_v2", "cleanup-c30.json"), "utf8"));
const LISTING = FIXTURE.listing;
const JOB_ID = c30.seed.base.job_id;
const CLIP_ID = c30.seed.clip_id;
const URL_PATH = `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/cleanup`;
const IDS = { id: JOB_ID, clipId: CLIP_ID };

function python() {
  const configured = process.env.PYTHON_BIN;
  if (configured) return configured.includes(path.sep) ? path.resolve(configured) : configured;
  return path.join(REPO, ".venv", "bin", "python");
}

function authorize(request) {
  return isAuthorized(request, AUTH) ? null : Response.json({ error: "Sesi login tidak valid" }, { status: 401 });
}

function env(extra = {}) {
  return { ...AUTH, PATH: process.env.PATH, JOBS_ROOT: "/data/jobs", POTONGIN_EDITOR_V3: "on", ...extra };
}

function request(url, { headers = {}, cookie = true } = {}) {
  const all = { Host: "local", ...headers };
  if (cookie) all.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  return new Request(`http://local${url}`, { method: "GET", headers: all });
}

function context(params) {
  return { params: Promise.resolve(params) };
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, text, headers: response.headers };
}

function recorder(result) {
  const calls = [];
  const runCli = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    if (result instanceof Error) throw result;
    return typeof result === "function" ? result(payload) : result;
  };
  return { calls, runCli };
}

function ok(json = LISTING) {
  return { exitCode: 0, json: structuredClone(json) };
}

// --- the route ---------------------------------------------------------------------------------------

test("the cleanup route module exports GET only and runs on node", () => {
  assert.equal(typeof cleanupRouteModule.GET, "function");
  assert.equal(cleanupRouteModule.runtime, "nodejs");
  assert.equal(cleanupRouteModule.dynamic, "force-dynamic");
  assert.deepEqual(Object.keys(cleanupRouteModule).sort(), ["GET", "dynamic", "runtime"]);
});

test("a session, then the flag, then the ids; nothing is spawned before", async () => {
  const { calls, runCli } = recorder(ok());
  const route = createCleanupRoute({ authorize, env: env(), runCli });
  assert.equal((await route.GET(request(URL_PATH, { cookie: false }), context(IDS))).status, 401);
  const off = createCleanupRoute({ authorize, env: env({ POTONGIN_EDITOR_V3: "off" }), runCli });
  const disabled = await read(await off.GET(request(URL_PATH), context(IDS)));
  assert.equal(disabled.status, 404);
  assert.equal(disabled.body.code, "editor_disabled");
  for (const [id, clipId] of [["../etc", CLIP_ID], [JOB_ID, "clip_x"], [JOB_ID, `${CLIP_ID}/..`], [JOB_ID.toUpperCase(), CLIP_ID]]) {
    const result = await read(await route.GET(request(URL_PATH), context({ id, clipId })));
    assert.equal(result.status, 400, `${id} ${clipId}`);
  }
  for (const query of ["?x=1", "?sha=abc", "?"]) {
    const result = await read(await route.GET(request(`${URL_PATH}${query}`), context(IDS)));
    assert.equal(result.status, query === "?" ? 200 : 400, query);
  }
  assert.equal(calls.length, 1);
});

test("GET runs the cleanup CLI op list with the ids only, without the LLM environment", async () => {
  const { calls, runCli } = recorder(ok());
  const route = createCleanupRoute({ authorize, env: env(), runCli });
  const result = await read(await route.GET(request(URL_PATH), context(IDS)));
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(calls.map(({ module, op, payload }) => [module, op, payload]), [[CLEANUP_MODULE, "list", { jobId: JOB_ID, clipId: CLIP_ID }]]);
  assert.notEqual(calls[0].options?.withLlmEnv, true);
  assert.equal(CLEANUP_MODULE, "ai_clipper.edit_v2.cleanup");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("cache-control"), "private, no-cache");
  assert.deepEqual(result.body.items, LISTING.items);
  assert.equal(result.body.wordsSha256, LISTING.wordsSha256);
});

test("the ETag is the digest of the list itself; If-None-Match answers 304", async () => {
  const { runCli } = recorder(ok());
  const route = createCleanupRoute({ authorize, env: env(), runCli });
  const first = await read(await route.GET(request(URL_PATH), context(IDS)));
  const expected = createHash("sha256").update(JSON.stringify(first.body)).digest("hex");
  assert.equal(first.headers.get("etag"), `"${expected}"`);
  const again = await route.GET(request(URL_PATH, { headers: { "If-None-Match": `W/"${expected}"` } }), context(IDS));
  assert.equal(again.status, 304);
  assert.equal(again.headers.get("etag"), `"${expected}"`);
  const other = await route.GET(request(URL_PATH, { headers: { "If-None-Match": `"${"0".repeat(64)}"` } }), context(IDS));
  assert.equal(other.status, 200);
  // a server whose rules changed answers a different list for the same words and lexicon: a
  // browser holding the old list must not get 304
  const changed = { ...LISTING, items: LISTING.items.slice(1) };
  const newer = createCleanupRoute({ authorize, env: env(), runCli: recorder({ exitCode: 0, json: changed }).runCli });
  const fresh = await newer.GET(request(URL_PATH, { headers: { "If-None-Match": `"${expected}"` } }), context(IDS));
  assert.equal(fresh.status, 200);
  assert.notEqual(fresh.headers.get("etag"), `"${expected}"`);
});

test("CLI failures map to fixed codes and never leak details", async () => {
  const cases = [
    [{ exitCode: 8, json: { error: { code: "analysis_missing" } } }, 409, "analysis_missing"],
    [{ exitCode: 4, json: { error: { code: "not_found" } } }, 404, "not_found"],
    [new PythonCliError("timeout"), 503, "backend_unavailable"],
    [{ exitCode: 0, json: { ...LISTING, items: [{ ...LISTING.items[0], id: "../x" }] } }, 503, "backend_unavailable"],
    [{ exitCode: 0, json: { ...LISTING, wordsSha256: "/data/jobs/secret" } }, 503, "backend_unavailable"],
  ];
  for (const [answer, status, code] of cases) {
    const { runCli } = recorder(answer);
    const result = await read(await createCleanupRoute({ authorize, env: env(), runCli }).GET(request(URL_PATH), context(IDS)));
    assert.equal(result.status, status, JSON.stringify(answer));
    assert.equal(result.body.code, code);
    assert.ok(!result.text.includes("/data/jobs"));
  }
});

test("sanitizeCleanup keeps exactly the DTO fields of each item kind", () => {
  const extra = structuredClone(LISTING);
  extra.items = extra.items.map((item) => ({ ...item, path: "/secret", text: "<b>x</b>" }));
  extra.debug = { stack: "trace" };
  const clean = sanitizeCleanup(extra);
  assert.deepEqual(clean.items, LISTING.items);
  assert.equal(clean.debug, undefined);
  for (const broken of [
    { ...LISTING, items: [{ ...LISTING.items.find((item) => item.kind === "filler"), wordIds: ["x1"] }] },
    { ...LISTING, items: [{ ...LISTING.items.find((item) => item.kind === "gap_silent"), inSf: 5, outSf: 5 }] },
    { ...LISTING, items: [{ ...LISTING.items[0], kind: "gap_voiced_auto" }] },
    { ...LISTING, items: "nope" },
    { ...LISTING, lexicon: { version: "v", sha256: "short" } },
    null,
  ]) assert.equal(sanitizeCleanup(broken), null);
});

test("the real cleanup CLI through python-cli answers the committed c30 list", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "clip-cleanup-real-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const clip = path.join(root, JOB_ID, "analysis", "clips", CLIP_ID);
  await mkdir(clip, { recursive: true });
  await writeFile(path.join(clip, "seed.json"), await readFile(path.join(CONTEXTS, "c30.seed.json")));
  const wordsRaw = await readFile(path.join(CONTEXTS, "c30.words.json"));
  const sha = createHash("sha256").update(wordsRaw).digest("hex");
  assert.equal(sha, c30.seed.base.words.sha256);
  await writeFile(path.join(clip, `words.${sha.slice(0, 16)}.json`), wordsRaw);
  const route = createCleanupRoute({ authorize, env: env({ JOBS_ROOT: root }), pythonBin: python() });
  const result = await read(await route.GET(request(URL_PATH), context(IDS)));
  assert.equal(result.status, 200, result.text);
  assert.deepEqual(result.body, sanitizeCleanup(LISTING));
  assert.ok(!result.text.includes(root));
  const missing = randomId();
  assert.equal((await route.GET(request(`/api/jobs/${missing}/clips/${CLIP_ID}/cleanup`), context({ id: missing, clipId: CLIP_ID }))).status, 404);
});

function randomId() {
  return "0f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
}

// --- the review model ----------------------------------------------------------------------------------

const ctx = createContext({ words: c30.words, seed: c30.seed });

function plain(item) {
  return item.kind === "gap_silent"
    ? { id: item.id, kind: item.kind, afterWord: item.afterWord, inSf: item.inSf, outSf: item.outSf }
    : { id: item.id, kind: item.kind, wordIds: item.wordIds };
}

function appliesAlone(doc, item) {
  try {
    applyCommand(doc, "ApplyCleanup", { items: [plain(item)] }, ctx);
    return true;
  } catch (error) {
    if (!(error instanceof CommandRejected)) throw error;
    return false;
  }
}

test("normalizeListing takes the route DTO and the fakes' shape, and drops what it cannot use", () => {
  const listing = normalizeListing(LISTING);
  assert.equal(listing.ok, true);
  assert.equal(listing.items.length, LISTING.items.length);
  assert.equal(listing.precheck, false);
  const fake = normalizeListing({ items: [
    { id: "fl_1", kind: "filler", wordIds: ["w048127"], label: "Jadi", defaultOn: false },
    { id: "gp_1", kind: "gap_silent", afterWord: "w048126", inSf: 10, outSf: 20, label: "jeda", defaultOn: true },
    { id: "BAD", kind: "filler", wordIds: ["w048127"] },
    { id: "zz_1", kind: "mystery" },
  ] });
  assert.deepEqual(fake.items.map((item) => item.id), ["fl_1", "gp_1"]);
  assert.equal(normalizeListing(null).ok, false);
  assert.deepEqual(KIND_ORDER, ["filler", "repeat", "gap_silent", "gap_voiced"]);
});

test("the view shows exactly the items that apply to the current document, with their defaults", () => {
  const doc = c30.seed;
  const view = cleanupView({ listing: LISTING, doc, words: c30.words, ctx });
  const shown = new Set(view.entries.map((entry) => entry.id));
  for (const item of LISTING.items) {
    if (item.kind === "gap_voiced") continue;
    assert.equal(shown.has(item.id), appliesAlone(doc, item), item.id);
  }
  assert.ok(view.entries.length > 5);
  for (const entry of view.entries) {
    if (entry.kind === "gap_voiced") {
      assert.equal(entry.checkable, false);
      assert.equal(entry.status, "listen");
    } else {
      assert.equal(entry.status, "open");
      assert.equal(entry.checkable, true);
    }
    assert.equal(entry.defaultOn, entry.kind === "gap_silent");
    assert.ok(entry.context.removed.length > 0 || entry.kind.startsWith("gap"), entry.id);
  }
  assert.deepEqual([...defaultChecked(view)].sort(), view.entries.filter((entry) => entry.kind === "gap_silent").map((entry) => entry.id).sort());
  assert.equal(view.hidden.outside + view.entries.length + view.hidden.removed + view.hidden.applied >= LISTING.items.length - 1, true);
  assert.equal(view.locked, LISTING.locked.length);
});

test("Terapkan (n) is one ApplyCleanup that cuts at Python's edges, and one undo restores the clip", () => {
  const doc = c30.seed;
  const view = cleanupView({ listing: LISTING, doc, words: c30.words, ctx });
  const checked = new Set(view.entries.filter((entry) => entry.checkable).map((entry) => entry.id));
  const plan = planApply({ view, checked, doc, ctx });
  assert.equal(plan.skipped.length, 0, JSON.stringify(plan.skipped));
  assert.equal(plan.args.items.length, checked.size);
  const session = createEditSession({ doc, ctx, now: () => 0 });
  const result = session.dispatch("ApplyCleanup", plan.args);
  assert.equal(result.changed, true);
  assert.equal(session.history.size, 1);
  assert.equal(session.history.entries[0].steps.length, 1);
  const applied = result.doc;
  for (const item of plan.args.items) {
    // each item alone cuts exactly where cleanup.removal_edges says (the pytest-checked fixture)
    const alone = applyCommand(doc, "ApplyCleanup", { items: [item] }, ctx).doc;
    const added = alone.main.removals.find((entry) => entry.origin === `suggestion:${item.id}`);
    const segment = doc.main.segments.find((entry) => entry.id === added.seg);
    const [inSf, outSf] = FIXTURE.edges[item.id];
    const cut = [Math.max(inSf, segment.in_sf), Math.min(outSf, segment.out_sf)];
    assert.deepEqual([added.in_sf, added.out_sf], cut, item.id);
    assert.equal(added.reason, item.kind);
    // together, touching cuts merge into one removal that still covers it (Appendix B)
    const covering = applied.main.removals.find((entry) => entry.seg === segment.id && entry.in_sf <= cut[0]
      && entry.out_sf >= cut[1] && entry.origin.startsWith("suggestion:"));
    assert.ok(covering, item.id);
  }
  assert.equal(session.undo(), true);
  assert.deepEqual(session.doc, doc);
  assert.equal(session.canUndo, false);
  assert.equal(session.redo(), true);
  assert.deepEqual(session.doc, applied);
  // applied items leave the list and are counted
  const after = cleanupView({ listing: LISTING, doc: applied, words: c30.words, ctx });
  assert.equal(after.entries.filter((entry) => entry.status === "open").length, 0);
  assert.equal(after.hidden.applied, plan.args.items.length);
});

test("planApply skips an item another checked item already covers, and names a blocked one", () => {
  const doc = c30.seed;
  const view = cleanupView({ listing: LISTING, doc, words: c30.words, ctx });
  const filler = view.entries.find((entry) => entry.kind === "filler");
  const twin = { ...filler, id: "cl_900" };
  const plan = planApply({ view: { ...view, entries: [filler, twin] }, checked: new Set([filler.id, twin.id]), doc, ctx });
  assert.deepEqual(plan.args.items.map((item) => item.id), [filler.id]);
  assert.deepEqual(plan.skipped.map(({ id, code }) => [id, code]), [["cl_900", "nothing_to_remove"]]);
  assert.equal(typeof plan.skipped[0].message, "string");
  const none = planApply({ view, checked: new Set(), doc, ctx });
  assert.deepEqual(none.args.items, []);
});

test("badges mark the words and gaps of the open items; audition spans the item with context", () => {
  const doc = c30.seed;
  const view = cleanupView({ listing: LISTING, doc, words: c30.words, ctx });
  const marks = badgeMarks(view);
  const model = buildTranscriptModel(c30.words, doc);
  for (const entry of view.entries) {
    if (entry.wordIdx.length) for (const index of entry.wordIdx) assert.equal(marks.words.get(index), entry.kind);
    else assert.equal(marks.gaps.get(entry.afterIdx), entry.kind);
    const range = auditionRange(entry, model);
    assert.ok(range && range.from >= 0 && range.to <= model.total && range.from < range.to, entry.id);
    const [num, den] = model.fps;
    assert.ok(range.to - range.from >= Math.round(num / den), "at least a second of context");
  }
});

test("the fakes' review list works over the fake document", async () => {
  const api = createFakeApiClient();
  const listing = await api.cleanup();
  const words = fakeWords();
  const doc = fakeDoc();
  const fakeCtx = createContext({ words, seed: doc });
  const view = cleanupView({ listing, doc, words, ctx: fakeCtx });
  assert.ok(view.entries.length >= 1);
  assert.ok(view.entries.every((entry) => typeof entry.context.removed === "string"));
  assert.equal(FAKE_JOB_ID.length, 36);
  assert.equal(FAKE_CLIP_ID.startsWith("clip_"), true);
});
