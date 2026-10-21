// "Pakai di semua klip" in the editor (CONTRACTS §5.48): the texts of web/lib/editor/apply-all.mjs
// and its controller (save first, one batch per click, the same key after a lost answer, undo).
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createApiClient } from "../lib/editor/api-client.mjs";
import {
  APPLY_GROUPS,
  applyErrorText,
  applySummary,
  createApplyAll,
  skippedLines,
  undoSummary,
} from "../lib/editor/apply-all.mjs";
import { createFakeApiClient } from "../components/editor/__dev__/fakes.mjs";

const JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const CLIP = "clip_62654c2c2fa04f125391464a";
const OTHER = "clip_000000000000000000000002";
const ETAG = "d".repeat(64);
const KEYS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333"];

const result = (extra = {}) => ({
  batchId: KEYS[0], group: "captions", applied: [{ clipId: OTHER, index: 2 }, { clipId: OTHER, index: 4 }],
  skipped: [{ clipId: OTHER, index: 3, reason: "edited" }], unchanged: [], ...extra,
});

test("the three groups have their own button text", () => {
  assert.deepEqual(Object.keys(APPLY_GROUPS), ["captions", "logo", "layout"]);
  assert.equal(APPLY_GROUPS.captions.button, "Pakai caption di semua klip");
  assert.equal(APPLY_GROUPS.logo.button, "Pakai logo di semua klip");
  assert.equal(APPLY_GROUPS.layout.button, "Pakai tata letak di semua klip");
  for (const group of Object.values(APPLY_GROUPS)) assert.ok(group.note.length < 80, group.note);
});

test("the result reads 'Dipakai di n klip · k dilewati' and names each skipped clip", () => {
  assert.equal(applySummary(result()), "Dipakai di 2 klip · 1 dilewati");
  assert.equal(applySummary(result({ skipped: [] })), "Dipakai di 2 klip · 0 dilewati");
  assert.equal(applySummary(result({ unchanged: [{ clipId: OTHER, index: 5 }] })), "Dipakai di 2 klip · 1 dilewati · 1 sudah sama");
  assert.equal(applySummary(result({ applied: [], skipped: [], unchanged: [{ clipId: OTHER, index: 5 }] })), "Semua klip lain sudah sama");
  assert.equal(applySummary(result({ applied: [], skipped: [], unchanged: [] })), "Tidak ada klip lain");
  assert.deepEqual(skippedLines([
    { index: 3, reason: "edited" }, { index: 4, reason: "not_ready" }, { index: 5, reason: "read_only" },
    { index: 6, reason: "conflict" }, { index: 7, reason: "invalid" }, { index: 8, reason: "changed" }, { index: 9, reason: "odd" },
  ]), [
    "Klip 3: sudah diubah manual", "Klip 4: belum disiapkan", "Klip 5: transkripnya berubah",
    "Klip 6: berubah saat diterapkan", "Klip 7: tidak muat di klip ini", "Klip 8: sudah diubah lagi", "Klip 9: dilewati",
  ]);
  assert.equal(undoSummary({ restored: [{ index: 2 }, { index: 4 }], skipped: [] }), "Dikembalikan di 2 klip");
  assert.equal(undoSummary({ restored: [{ index: 2 }], skipped: [{ index: 4, reason: "changed" }] }), "Dikembalikan di 1 klip · 1 dilewati");
  for (const text of [applySummary(result()), ...skippedLines(result().skipped), undoSummary({ restored: [], skipped: [] })]) {
    assert.doesNotMatch(text, /—/);
  }
});

test("errors become short Indonesian messages", () => {
  assert.equal(applyErrorText({ code: "conflict_unresolved" }), "Selesaikan bentrok perubahan dulu");
  assert.equal(applyErrorText({ code: "revision_conflict", status: 409 }), "Klip ini diubah di tab lain; muat ulang dulu");
  assert.equal(applyErrorText({ code: "not_found", status: 404 }, "undo"), "Sudah tidak bisa diurungkan");
  assert.equal(applyErrorText({ code: "network_error", status: 0 }), "Gagal menerapkan; coba lagi");
  assert.equal(applyErrorText({ code: "network_error", status: 0 }, "undo"), "Gagal mengurungkan; coba lagi");
  assert.equal(applyErrorText({ code: "rate_limited", status: 429 }), "Terlalu banyak permintaan; tunggu sebentar");
});

function harness({ answers = [], undoAnswers = [], flushes = [ETAG] } = {}) {
  const calls = [];
  const keys = [...KEYS];
  const api = {
    async applyToAll(body, key) {
      calls.push(["apply", body, key]);
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    async undoApplyAll(batchId) {
      calls.push(["undo", batchId]);
      const next = undoAnswers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
  };
  const flush = async () => {
    calls.push(["flush"]);
    const next = flushes.length > 1 ? flushes.shift() : flushes[0];
    if (next instanceof Error) throw next;
    return next;
  };
  const controller = createApplyAll({ api, flush, newKey: () => keys.shift() });
  return { controller, calls };
}

const failure = (status, code) => Object.assign(new Error(code), { status, code });

test("apply saves the clip first, sends one batch with its saved etag, then shows the result", async () => {
  const { controller, calls } = harness({ answers: [result()] });
  const seen = [];
  controller.subscribe(() => seen.push(controller.get("captions").phase));
  const done = controller.apply("captions");
  assert.equal(controller.get("captions").phase, "running");
  await done;
  assert.deepEqual(calls, [["flush"], ["apply", { group: "captions", etag: ETAG }, KEYS[0]]]);
  assert.deepEqual(controller.get("captions"), { phase: "done", result: result(), undo: null, message: null });
  assert.deepEqual(controller.get("logo"), { phase: "idle", result: null, undo: null, message: null });
  assert.deepEqual(seen, ["running", "done"]);
  // A second click while one runs does nothing.
  const again = harness({ answers: [result()] });
  const first = again.controller.apply("captions");
  await again.controller.apply("captions");
  await first;
  assert.equal(again.calls.filter(([kind]) => kind === "apply").length, 1);
});

test("a lost answer is retried with the same key, so the server replays instead of skipping", async () => {
  const { controller, calls } = harness({ answers: [failure(0, "network_error"), failure(503, "backend_unavailable"), result()] });
  await controller.apply("captions");
  assert.deepEqual(controller.get("captions"), { phase: "error", result: null, undo: null, message: "Gagal menerapkan; coba lagi" });
  await controller.apply("captions");
  await controller.apply("captions");
  const keys = calls.filter(([kind]) => kind === "apply").map(([, , key]) => key);
  assert.deepEqual(keys, [KEYS[0], KEYS[0], KEYS[0]]);
  assert.equal(controller.get("captions").phase, "done");
  // A new save (another etag) or a refused request starts a new batch.
  const fresh = harness({ answers: [failure(0, "network_error"), result()], flushes: [ETAG, "e".repeat(64)] });
  await fresh.controller.apply("captions");
  await fresh.controller.apply("captions");
  assert.deepEqual(fresh.calls.filter(([kind]) => kind === "apply").map(([, , key]) => key), [KEYS[0], KEYS[1]]);
  const refused = harness({ answers: [failure(409, "revision_conflict"), result()] });
  await refused.controller.apply("captions");
  await refused.controller.apply("captions");
  assert.deepEqual(refused.calls.filter(([kind]) => kind === "apply").map(([, , key]) => key), [KEYS[0], KEYS[1]]);
});

test("a save that fails or waits on a conflict sends nothing", async () => {
  const { controller, calls } = harness({ flushes: [Object.assign(new Error("conflict"), { code: "conflict_unresolved" })] });
  await controller.apply("layout");
  assert.deepEqual(calls, [["flush"]]);
  assert.deepEqual(controller.get("layout"), { phase: "error", result: null, undo: null, message: "Selesaikan bentrok perubahan dulu" });
});

test("Urungkan undoes the batch once and keeps both results", async () => {
  const undone = { batchId: KEYS[0], group: "captions", restored: [{ clipId: OTHER, index: 2 }], skipped: [{ clipId: OTHER, index: 4, reason: "changed" }] };
  const { controller, calls } = harness({ answers: [result()], undoAnswers: [failure(0, "network_error"), undone] });
  await controller.undo("captions");
  assert.equal(calls.length, 0, "nothing to undo before a batch");
  await controller.apply("captions");
  await controller.undo("captions");
  assert.equal(controller.get("captions").phase, "done");
  assert.equal(controller.get("captions").message, "Gagal mengurungkan; coba lagi");
  await controller.undo("captions");
  assert.deepEqual(calls.filter(([kind]) => kind === "undo"), [["undo", KEYS[0]], ["undo", KEYS[0]]]);
  assert.deepEqual(controller.get("captions"), { phase: "undone", result: result(), undo: undone, message: null });
  await controller.undo("captions");
  assert.equal(calls.filter(([kind]) => kind === "undo").length, 2, "an undone batch is not undone again");
});

test("the other clips of the job decide whether the button shows", () => {
  const { controller } = harness();
  assert.equal(controller.others(), null);
  controller.setClips([{ clipId: CLIP }, { clipId: OTHER }, { clipId: null }], CLIP);
  assert.equal(controller.others(), 2);
  controller.setClips([{ clipId: CLIP }], CLIP);
  assert.equal(controller.others(), 0);
});

test("the API client posts the batch with its key and the undo to the job's route", async () => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const api = createApiClient({ jobId: JOB, clipId: CLIP, fetchImpl });
  await api.applyToAll({ group: "logo", etag: ETAG }, KEYS[0]);
  await api.undoApplyAll(KEYS[0]);
  assert.deepEqual(requests.map(({ url, method }) => [method, url]), [
    ["POST", `/api/jobs/${JOB}/clips/${CLIP}/apply-all`],
    ["POST", `/api/jobs/${JOB}/apply-all/${KEYS[0]}/undo`],
  ]);
  assert.equal(requests[0].headers["Idempotency-Key"], KEYS[0]);
  assert.deepEqual(JSON.parse(requests[0].body), { group: "logo", etag: ETAG });
  assert.equal(requests[1].body, "{}");
  await assert.rejects(() => api.applyToAll({ group: "music", etag: ETAG }, KEYS[0]), TypeError);
  await assert.rejects(() => api.applyToAll({ group: "logo", etag: "x" }, KEYS[0]), TypeError);
  await assert.rejects(() => api.undoApplyAll("../x"), TypeError);
});

test("the fake API answers a batch and its undo for the e2e specs", async () => {
  const api = createFakeApiClient();
  const answer = await api.applyToAll({ group: "captions", etag: ETAG }, KEYS[0]);
  assert.equal(answer.batchId, KEYS[0]);
  assert.equal(answer.group, "captions");
  assert.ok(Array.isArray(answer.applied) && Array.isArray(answer.skipped) && Array.isArray(answer.unchanged));
  const undone = await api.undoApplyAll(KEYS[0]);
  assert.equal(undone.batchId, KEYS[0]);
  assert.deepEqual(undone.restored, answer.applied);
  assert.deepEqual(api.calls.map(({ name }) => name), ["applyToAll", "undoApplyAll"]);
});

test("each settings place shows the button for its own group", async () => {
  const places = {
    "components/editor/quick/CaptionCard.jsx": "captions",
    "components/editor/panels/TextPanel.jsx": "captions",
    "components/editor/quick/ExtrasCard.jsx": "logo",
    "components/editor/panels/LogoPanel.jsx": "logo",
    "components/editor/quick/LayoutCard.jsx": "layout",
    "components/editor/panels/LayoutPanel.jsx": "layout",
  };
  for (const [file, group] of Object.entries(places)) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`<ApplyAll [^>]*group="${group}"`), file);
  }
});
