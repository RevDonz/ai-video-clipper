// "Ubah" and "Tulis ulang" in the project page's detail panel (plan 2026-10-20 P2): the form's
// state, the save and rewrite requests with the answers the page shows, and the page wiring.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { projectSource } from "./support/screen-sources.mjs";

import {
  CLIP_TEXT_COPY,
  CLIP_TEXT_EDIT_LIMITS,
  clipTextDraft,
  clipTextForm,
  replaceClip,
  rewriteClipText,
  saveClipText,
} from "../lib/clip-text.mjs";
import { CLIP_TEXT_LIMITS } from "../lib/jobs.mjs";
import { clipCaptionText } from "../lib/selection-v3-view.mjs";

const JOB_ID = "4d2c6b1a-7e3f-4a5b-9c8d-1e2f3a4b5c6d";
const CLIP = Object.freeze({ index: 3, title: "Judul mesin", description: "Cerita.\n\n#fyp #mall", hashtags: ["#fyp", "#mall"] });

function fakeFetch(status, body, { onCall } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    onCall?.(url, init);
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetchImpl };
}

test("the form limits are the job's own", () => {
  assert.equal(CLIP_TEXT_EDIT_LIMITS.title, CLIP_TEXT_LIMITS.title);
  assert.equal(CLIP_TEXT_EDIT_LIMITS.description, CLIP_TEXT_LIMITS.storedDescription);
});

test("the draft starts from the clip's title and whole description", () => {
  assert.deepEqual(clipTextDraft(CLIP), { title: "Judul mesin", description: "Cerita.\n\n#fyp #mall" });
  assert.deepEqual(clipTextDraft({ index: 1 }), { title: "", description: "" });
});

test("the form counts characters, names each problem and saves only a real change", () => {
  const same = clipTextForm(clipTextDraft(CLIP), CLIP);
  assert.deepEqual(same, {
    titleCount: "11/100", descriptionCount: "19/1.200", titleOver: false, descriptionOver: false,
    titleProblem: null, descriptionProblem: null, dirty: false, canSave: false,
  });
  assert.equal(clipTextForm({ title: " Judul  mesin ", description: "Cerita.\n\n#fyp #mall\n" }, CLIP).dirty, false,
    "spaces the server drops are not a change");
  const changed = clipTextForm({ title: "Judul baru", description: "" }, CLIP);
  assert.deepEqual([changed.dirty, changed.canSave, changed.descriptionCount], [true, true, "0/1.200"]);

  const empty = clipTextForm({ title: "   ", description: "x" }, CLIP);
  assert.deepEqual([empty.titleProblem, empty.titleOver, empty.canSave], ["Judul tidak boleh kosong.", false, false]);
  const long = clipTextForm({ title: "a".repeat(101), description: "x" }, CLIP);
  assert.deepEqual([long.titleCount, long.titleOver, long.titleProblem, long.canSave], ["101/100", true, "Judul paling banyak 100 karakter.", false]);
  const emoji = clipTextForm({ title: "😀".repeat(100), description: "" }, CLIP);
  assert.deepEqual([emoji.titleCount, emoji.titleProblem], ["100/100", null], "characters, not UTF-16 units");
  const longText = clipTextForm({ title: "Judul", description: "d".repeat(1201) }, CLIP);
  assert.deepEqual([longText.descriptionCount, longText.descriptionOver, longText.descriptionProblem, longText.canSave],
    ["1.201/1.200", true, "Deskripsi paling banyak 1.200 karakter.", false]);
});

test("saving sends one same-origin PATCH and hands back the clip as the job now serves it", async () => {
  const saved = { ...CLIP, title: "Judul baru", description: "Baru.", hashtags: [] };
  const { calls, fetchImpl } = fakeFetch(200, { clip: saved });
  const result = await saveClipText(JOB_ID, 3, { title: "Judul baru", description: "Baru." }, { fetchImpl });
  assert.deepEqual(result, { type: "saved", clip: saved });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `/api/jobs/${JOB_ID}/clip-text`);
  assert.equal(calls[0].init.method, "PATCH");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), { index: 3, title: "Judul baru", description: "Baru." });
  assert.equal(calls[0].init.cache, "no-store");
});

test("a refused save says why, next to the field it is about", async () => {
  const title = await saveClipText(JOB_ID, 3, { title: " ", description: "" },
    fakeFetch(400, { error: "Judul tidak boleh kosong.", code: "title_empty" }));
  assert.deepEqual(title, { type: "error", field: "title", message: "Judul tidak boleh kosong." });
  const description = await saveClipText(JOB_ID, 3, { title: "a", description: "" },
    fakeFetch(400, { error: "Deskripsi paling banyak 1.200 karakter.", code: "description_too_long" }));
  assert.equal(description.field, "description");
  const finished = await saveClipText(JOB_ID, 3, { title: "a", description: "" },
    fakeFetch(409, { error: "Judul dan deskripsi bisa diubah setelah proyek selesai.", code: "not_ready" }));
  assert.deepEqual([finished.field, finished.message], [null, "Judul dan deskripsi bisa diubah setelah proyek selesai."]);
  const broken = await saveClipText(JOB_ID, 3, { title: "a", description: "" }, fakeFetch(500, "<html>"));
  assert.deepEqual(broken, { type: "error", field: null, message: "Teks belum tersimpan. Coba lagi." });
  const wrongClip = await saveClipText(JOB_ID, 3, { title: "a", description: "" }, fakeFetch(200, { clip: { ...CLIP, index: 4 } }));
  assert.equal(wrongClip.type, "error");
  const offline = await saveClipText(JOB_ID, 3, { title: "a", description: "" }, { fetchImpl: async () => { throw new TypeError("network"); } });
  assert.deepEqual(offline, { type: "error", field: null, message: "Teks belum tersimpan. Periksa koneksi, lalu coba lagi." });
  const login = await saveClipText(JOB_ID, 3, { title: "a", description: "" }, fakeFetch(401, { code: "unauthorized" }));
  assert.deepEqual(login, { type: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${JOB_ID}`)}` });
  const aborted = new DOMException("stopped", "AbortError");
  await assert.rejects(saveClipText(JOB_ID, 3, { title: "a", description: "" }, { fetchImpl: async () => { throw aborted; } }), aborted);
});

test("Tulis ulang sends {index} and returns the suggestion as text to accept or discard", async () => {
  const suggestion = { title: "Judul AI", description: "Deskripsi AI. Kamu pernah?\n\n#fyp" };
  const { calls, fetchImpl } = fakeFetch(200, { suggestion });
  assert.deepEqual(await rewriteClipText(JOB_ID, 3, { fetchImpl }), { type: "suggestion", suggestion });
  assert.equal(calls[0].url, `/api/jobs/${JOB_ID}/clip-text/rewrite`);
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { index: 3 });
  const empty = await rewriteClipText(JOB_ID, 3, fakeFetch(200, { suggestion: { title: "", description: "x" } }));
  assert.equal(empty.type, "error");
});

test("a failed Tulis ulang reads like the page's other AI failures: what happened, how to fix it", async () => {
  const quota = await rewriteClipText(JOB_ID, 3, fakeFetch(502, {
    error: "AI tidak bisa dipakai sekarang. Cek penyedia di Pengaturan, lalu coba lagi.", code: "llm_unavailable", llmCode: "quota_exhausted",
  }));
  assert.deepEqual(quota, {
    type: "error", code: "llm_unavailable", title: "Tulis ulang gagal",
    message: "AI tidak bisa dipakai sekarang. Cek penyedia di Pengaturan, lalu coba lagi.",
    help: "/bantuan#llm_quota_exhausted", settings: "/settings",
  });
  const off = await rewriteClipText(JOB_ID, 3, fakeFetch(409, { error: "AI mati atau belum diatur. Nyalakan di Pengaturan.", code: "llm_disabled" }));
  assert.deepEqual([off.help, off.settings], ["/bantuan#llm_not_configured", "/settings"]);
  const slow = await rewriteClipText(JOB_ID, 3, fakeFetch(504, { error: "AI terlalu lama menjawab. Coba lagi.", code: "timeout" }));
  assert.deepEqual([slow.message, slow.help, slow.settings], ["AI terlalu lama menjawab. Coba lagi.", "/bantuan#llm_timeout", null]);
  const odd = await rewriteClipText(JOB_ID, 3, fakeFetch(502, { error: "Jawaban AI tidak bisa dipakai. Coba lagi.", code: "invalid_output", llmCode: null }));
  assert.deepEqual([odd.help, odd.settings], [null, null]);
  const limit = await rewriteClipText(JOB_ID, 3, fakeFetch(429, { error: "Batas Tulis ulang untuk proyek ini tercapai (30 per jam). Coba lagi dalam 2 menit.", code: "rate_limited" }));
  assert.match(limit.message, /30 per jam/);
  const offline = await rewriteClipText(JOB_ID, 3, { fetchImpl: async () => { throw new TypeError("network"); } });
  assert.equal(offline.message, "Tulis ulang gagal tersambung. Periksa koneksi, lalu coba lagi.");
  const broken = await rewriteClipText(JOB_ID, 3, fakeFetch(503, "<html>"));
  assert.equal(broken.message, "Tulis ulang tidak tersedia sekarang. Coba lagi sebentar lagi.");
  const login = await rewriteClipText(JOB_ID, 3, fakeFetch(401, {}));
  assert.equal(login.type, "redirect");
});

test("a saved clip replaces its own entry in the job; copying it follows", () => {
  const job = { id: JOB_ID, clips: [{ index: 1, title: "A" }, CLIP] };
  const saved = { ...CLIP, title: "Judul baru", description: "", hashtags: [] };
  const next = replaceClip(job, saved);
  assert.deepEqual(next.clips.map((clip) => clip.title), ["A", "Judul baru"]);
  assert.equal(job.clips[1].title, "Judul mesin", "the old job is not changed");
  assert.equal(clipCaptionText(saved), "Judul baru", "an empty description copies the title alone");
});

test("the words on screen are short Indonesian with no version label", () => {
  assert.equal(CLIP_TEXT_COPY.edit, "Ubah");
  assert.equal(CLIP_TEXT_COPY.rewrite, "Tulis ulang");
  for (const text of Object.values(CLIP_TEXT_COPY)) {
    assert.doesNotMatch(text, /—|\bV[1-3]\b|\bbaru\b.*versi|\bAI Powered\b|\bviral\b|\bhot\b/i, text);
  }
});

test("the clip viewer edits the clip it shows and hands the saved clip to the page", async () => {
  // The project page's files: the page keeps the job, the viewer holds the caption box.
  const page = await projectSource();
  assert.match(page, /<ClipText key=\{`text-\$\{clip\.index\}`\}/);
  assert.match(page, /onSaved=\{onClipSaved\}/);
  assert.match(page, /setJob\(\(current\) => replaceClip\(current, clip\)\)/);
  const component = await readFile(new URL("../components/ClipText.jsx", import.meta.url), "utf8");
  for (const call of ["saveClipText(", "rewriteClipText(", "clipTextForm("]) assert.ok(component.includes(call), call);
  assert.match(component, /maxLength|aria-describedby/);
  assert.match(component, /role="status"/);
  assert.match(component, /controller\.abort\(\)/);
  assert.doesNotMatch(component, /dangerouslySetInnerHTML|—/);
});
