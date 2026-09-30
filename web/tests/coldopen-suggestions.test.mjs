// Cold-open suggestions (plan §7.2, §4.2, §11.3 T3.7): GET /api/jobs/:id/clips/:clipId/
// coldopen-suggestions (the route over `python -m ai_clipper.edit_v2.coldopen list`) and the
// panel's model of each candidate against the current document.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as routeModule from "../app/api/jobs/[id]/clips/[clipId]/coldopen-suggestions/route.js";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { createSessionToken, isAuthorized } from "../lib/auth.mjs";
import { COLDOPEN_MODULE, createColdOpenSuggestionsRoute } from "../lib/coldopen-suggestions.mjs";
import { PythonCliError } from "../lib/python-cli.mjs";
import {
  SOURCE_LABELS, candidateViews, readCandidates, resolveEditorApi,
} from "../components/editor/panels/coldopen-suggestions.mjs";
import { buildTranscriptModel } from "../components/editor/transcript/model.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CONTEXTS = path.join(REPO, "tests", "fixtures", "edit_v2", "docs", "contexts");
const AUTH = Object.freeze({ APP_USERNAME: "admin", APP_PASSWORD: "pw-secret-value", APP_SESSION_SECRET: "session-secret-".padEnd(48, "z") });
const JOB_ID = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP_ID = "clip_62654c2c2fa04f125391464a";
const WORDS_SHA = "b".repeat(64);
const URL_PATH = `/api/jobs/${JOB_ID}/clips/${CLIP_ID}/coldopen-suggestions`;

const CANDIDATE = Object.freeze({
  id: "co_1", source: "selection", firstWord: "w048121", lastWord: "w048126", inSf: 37225, outSf: 37300,
  frames: 75, durMs: 2503, unitIds: ["S0412"], text: "Kenapa sutradara ditahan di film sendiri?", question: true,
  laughTail: false, reason: "Cold open yang dipakai saat klip dibuat",
});

function authorize(request) {
  return isAuthorized(request, AUTH) ? null
    : Response.json({ error: "Sesi login tidak valid" }, { status: 401, headers: { "Cache-Control": "no-store" } });
}

function env(extra = {}) {
  return { ...AUTH, PATH: process.env.PATH, JOBS_ROOT: "/data/jobs", POTONGIN_EDITOR_V3: "on", ...extra };
}

function request(url = URL_PATH, { headers = {}, cookie = true } = {}) {
  const all = { Host: "local", ...headers };
  if (cookie) all.Cookie = `potongin_session=${createSessionToken(AUTH)}`;
  return new Request(`http://local${url}`, { method: "GET", headers: all });
}

function context(params = { id: JOB_ID, clipId: CLIP_ID }) {
  return { params: Promise.resolve(params) };
}

async function read(response) {
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, body, headers: response.headers };
}

function runner(result) {
  const calls = [];
  const run = async (module, op, payload, options) => {
    calls.push({ module, op, payload, options });
    if (result instanceof Error) throw result;
    return typeof result === "function" ? result(payload) : structuredClone(result);
  };
  return { calls, run };
}

function route({ result = { exitCode: 0, json: { wordsSha256: WORDS_SHA, candidates: [CANDIDATE] } }, extraEnv = {},
  now = () => 1_000, ttlMs } = {}) {
  const cli = runner(result);
  const handler = createColdOpenSuggestionsRoute({ authorize, env: env(extraEnv), runCli: cli.run, now, ttlMs });
  return { handler, cli };
}

// --- the route --------------------------------------------------------------------------------

test("the route module exports only GET with the node runtime", () => {
  assert.deepEqual(Object.keys(routeModule).sort(), ["GET", "dynamic", "runtime"]);
  assert.equal(routeModule.dynamic, "force-dynamic");
  assert.equal(routeModule.runtime, "nodejs");
});

test("GET runs `coldopen list` for the clip and answers the sanitised candidates", async () => {
  const { handler, cli } = route();
  const response = await read(await handler.GET(request(), context()));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { wordsSha256: WORDS_SHA, candidates: [CANDIDATE] });
  assert.equal(cli.calls.length, 1);
  assert.deepEqual([cli.calls[0].module, cli.calls[0].op, cli.calls[0].payload], [COLDOPEN_MODULE, "list", { jobId: JOB_ID, clipId: CLIP_ID }]);
  assert.equal(COLDOPEN_MODULE, "ai_clipper.edit_v2.coldopen");
  assert.equal(response.headers.get("cache-control"), "private, no-cache");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("etag"), /^"[0-9a-f]{64}"$/);
});

test("a repeated GET is answered from memory; If-None-Match gives 304", async () => {
  let clock = 1_000;
  const { handler, cli } = route({ now: () => clock, ttlMs: 60_000 });
  const first = await handler.GET(request(), context());
  const etag = first.headers.get("etag");
  const second = await read(await handler.GET(request(), context()));
  assert.equal(second.status, 200);
  assert.equal(cli.calls.length, 1);
  const cached = await handler.GET(request(URL_PATH, { headers: { "If-None-Match": etag } }), context());
  assert.equal(cached.status, 304);
  assert.equal(cached.headers.get("etag"), etag);
  clock += 60_001;
  await handler.GET(request(), context());
  assert.equal(cli.calls.length, 2, "the memo expires");
});

test("auth, the editor flag, ids and query strings are checked before anything runs", async () => {
  const cases = [
    [request(URL_PATH, { cookie: false }), context(), 401, null, {}],
    [request(), context(), 404, "editor_disabled", { POTONGIN_EDITOR_V3: "off" }],
    [request(), context({ id: "../etc", clipId: CLIP_ID }), 400, "invalid_request", {}],
    [request(), context({ id: JOB_ID, clipId: "clip_x" }), 400, "invalid_request", {}],
    [request(`${URL_PATH}?refresh=1`), context(), 400, "invalid_request", {}],
  ];
  for (const [req, ctx, status, code, extraEnv] of cases) {
    const { handler, cli } = route({ extraEnv });
    const response = await read(await handler.GET(req, ctx));
    assert.equal(response.status, status, code);
    if (code) assert.equal(response.body.code, code);
    assert.equal(cli.calls.length, 0);
  }
});

test("CLI failures map to fixed codes and are never cached", async () => {
  const cases = [
    [{ exitCode: 8, json: { error: { code: "analysis_missing" } } }, 409, "analysis_missing"],
    [{ exitCode: 4, json: { error: { code: "not_found" } } }, 404, "not_found"],
    [new PythonCliError("timeout"), 503, "backend_unavailable"],
    [{ exitCode: 0, json: { candidates: "nope" } }, 503, "backend_unavailable"],
    [{ exitCode: 0, json: { wordsSha256: "x", candidates: [] } }, 503, "backend_unavailable"],
  ];
  for (const [result, status, code] of cases) {
    const { handler, cli } = route({ result });
    for (let i = 0; i < 2; i += 1) {
      const response = await read(await handler.GET(request(), context()));
      assert.equal(response.status, status, code);
      assert.equal(response.body.code, code);
      assert.doesNotMatch(JSON.stringify(response.body), /\/data|Traceback|stderr/);
    }
    assert.equal(cli.calls.length, 2, `${code} is not cached`);
  }
});

test("sanitising keeps only well-formed candidates, the known keys and at most five", async () => {
  const bad = [
    { ...CANDIDATE, id: "CO-1" },
    { ...CANDIDATE, firstWord: "x1" },
    { ...CANDIDATE, source: "llm" },
    { ...CANDIDATE, inSf: 1.5 },
    { ...CANDIDATE, frames: -1 },
    { ...CANDIDATE, unitIds: ["S1", 3] },
    { ...CANDIDATE, text: 7 },
    null,
  ];
  const many = Array.from({ length: 8 }, (_, i) => ({ ...CANDIDATE, id: `co_${i + 1}`, extra: "drop me" }));
  const { handler } = route({ result: { exitCode: 0, json: { wordsSha256: WORDS_SHA, candidates: [...bad, ...many] } } });
  const response = await read(await handler.GET(request(), context()));
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.candidates.map((candidate) => candidate.id), ["co_1", "co_2", "co_3", "co_4", "co_5"]);
  assert.ok(response.body.candidates.every((candidate) => !("extra" in candidate)));
  const long = { ...CANDIDATE, text: "a".repeat(900), reason: "b".repeat(300) };
  const trimmed = await read(await route({ result: { exitCode: 0, json: { wordsSha256: WORDS_SHA, candidates: [long] } } })
    .handler.GET(request(), context()));
  assert.equal(trimmed.body.candidates[0].text.length, 400);
  assert.equal(trimmed.body.candidates[0].reason.length, 120);
});

// --- the panel's model --------------------------------------------------------------------------

const words = JSON.parse(readFileSync(path.join(CONTEXTS, "c25.words.json"), "utf8"));
const seed = JSON.parse(readFileSync(path.join(CONTEXTS, "c25.seed.json"), "utf8"));
const fps = seed.output.fps;
const body = seed.main.segments.find((segment) => segment.role === "body");

function unitRange(unitId) {
  const indices = words.words.flatMap((word, index) => (word.u === unitId ? [index] : []));
  return [indices[0], indices.at(-1)];
}

function candidateFor(unitId, id = "co_1", source = "strong") {
  const [first, last] = unitRange(unitId);
  const before = words.bounds.find((bound) => bound.before === words.words[first].id).sf;
  const after = words.bounds.find((bound) => bound.after === words.words[last].id).sf;
  return { id, source, firstWord: words.words[first].id, lastWord: words.words[last].id, inSf: before, outSf: after,
    frames: after - before, durMs: Math.round(((after - before) * 1000 * fps[1]) / fps[0]), unitIds: [unitId],
    text: words.words.slice(first, last + 1).map((word) => word.t).join(" "), question: false, laughTail: false,
    reason: "Kalimat kuat" };
}

// A body unit well inside the clip (not its opening), short enough for a cold open.
const target = words.units.find((unit) => {
  const [first, last] = unitRange(unit.id);
  const mid = (index) => Math.floor(((words.words[index].s + words.words[index].e) * fps[0]) / (2000 * fps[1]));
  return mid(first) >= body.in_sf + 250 && mid(last) < body.out_sf - 50 && unit.e - unit.s >= 1200 && unit.e - unit.s <= 5000;
});

test("a candidate view carries the label, the length and whether 'Pakai' is possible now", () => {
  const candidate = candidateFor(target.id);
  const model = buildTranscriptModel(words, seed);
  const [view] = candidateViews({ candidates: [candidate], model });
  assert.equal(view.label, SOURCE_LABELS.strong);
  assert.equal(view.ok, true);
  assert.equal(view.current, false);
  assert.equal(view.frames, candidate.frames);
  assert.match(view.duration, /^\d+,\d dtk$/);
  assert.equal(view.text, candidate.text);
  assert.deepEqual(view.command, { type: "SetColdOpen", args: { firstWord: candidate.firstWord, lastWord: candidate.lastWord }, mergeKey: null });
});

test("'Pakai' applies the exact SetColdOpen, and the view then reads as the current cold open", () => {
  const candidate = candidateFor(target.id);
  const ctx = createContext({ words, seed });
  const { doc } = applyCommand(seed, "SetColdOpen", { firstWord: candidate.firstWord, lastWord: candidate.lastWord }, ctx);
  const co = doc.main.segments[0];
  assert.deepEqual([co.role, co.in_sf, co.out_sf], ["cold_open", candidate.inSf, candidate.outSf]);
  const [view] = candidateViews({ candidates: [candidate], model: buildTranscriptModel(words, doc) });
  assert.equal(view.current, true);
  assert.equal(view.ok, false);
  assert.equal(view.blockReason, "Sedang dipakai sebagai cold open");
  assert.deepEqual(view.audition, { f0: 0, f1: candidate.frames });
});

test("audition plays the candidate where the body shows it; it is gone once cut out", () => {
  const candidate = candidateFor(target.id);
  const model = buildTranscriptModel(words, seed);
  const [view] = candidateViews({ candidates: [candidate], model });
  assert.equal(view.audition.f0, candidate.inSf - body.in_sf);
  assert.equal(view.audition.f1, candidate.outSf - body.in_sf);
  const ctx = createContext({ words, seed });
  const [first, last] = unitRange(target.id);
  const cut = applyCommand(seed, "RemoveWords", { wordIds: words.words.slice(first, last + 1).map((word) => word.id),
    reason: "user", origin: "user" }, ctx).doc;
  const [gone] = candidateViews({ candidates: [candidate], model: buildTranscriptModel(words, cut) });
  assert.equal(gone.audition, null);
  assert.equal(gone.auditionReason, "Bagian ini sudah dipotong dari klip");
});

test("a candidate that now repeats the opening is shown but cannot be used, with the reason", () => {
  const candidate = candidateFor(target.id);
  const ctx = createContext({ words, seed });
  const trimmed = applyCommand(seed, "TrimStart", { gapWord: candidate.firstWord }, ctx).doc;
  const [view] = candidateViews({ candidates: [candidate], model: buildTranscriptModel(words, trimmed) });
  assert.equal(view.ok, false);
  assert.equal(view.blockReason, "Cold open ini hanya mengulang awal klip");
});

test("a candidate whose words are unknown to this words artifact is dropped", () => {
  const model = buildTranscriptModel(words, seed);
  const views = candidateViews({ candidates: [{ ...candidateFor(target.id), firstWord: "w999999" }, candidateFor(target.id, "co_2")], model });
  assert.deepEqual(views.map((view) => view.id), ["co_2"]);
});

test("readCandidates accepts the route shape (and the fakes' shorter one)", () => {
  assert.deepEqual(readCandidates({ wordsSha256: WORDS_SHA, candidates: [CANDIDATE] }), [CANDIDATE]);
  const fake = { candidates: [{ id: "co_1", firstWord: "w048121", lastWord: "w048126", durMs: 2470, reason: "pertanyaan pembuka" }] };
  assert.deepEqual(readCandidates(fake).map((candidate) => [candidate.id, candidate.source, candidate.reason]),
    [["co_1", null, "pertanyaan pembuka"]]);
  assert.deepEqual(readCandidates({ candidates: [{ id: "x", firstWord: "w1" }] }), []);
  assert.deepEqual(readCandidates(null), []);
});

test("the API: the one passed in, else the fake runtime's, else a client for the clip", () => {
  const given = { coldOpenSuggestions: async () => ({}) };
  const state = { jobId: JOB_ID, clipId: CLIP_ID };
  assert.equal(resolveEditorApi({ api: given, state }), given);
  const fake = { coldOpenSuggestions: async () => ({}) };
  assert.equal(resolveEditorApi({ state, global: { __potonginEditor: { api: fake } } }), fake);
  const created = resolveEditorApi({ state, global: {} });
  assert.equal(typeof created.coldOpenSuggestions, "function");
  assert.equal(resolveEditorApi({ state: { jobId: "x", clipId: CLIP_ID }, global: {} }), null);
});
