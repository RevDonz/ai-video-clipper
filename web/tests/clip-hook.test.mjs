// "Hook di video" on the project page (CONTRACTS §5.57): when the switch shows, the save and the
// export it sends, the answers the page shows, the listing poll while an export runs, and the
// page wiring.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { projectSource } from "./support/screen-sources.mjs";

import { clipEntryView, entriesExporting } from "../lib/clip-entry-view.mjs";
import { HOOK_COPY, hookSwitchView, switchHook } from "../lib/clip-hook.mjs";

const JOB = "4d2c6b1a-7e3f-4a5b-9c8d-1e2f3a4b5c6d";
const CLIP = "clip_62654c2c2fa04f125391464a";
const ETAG = "a".repeat(64);
const NEXT = "b".repeat(64);
const RENDER = "5a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const KEYS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

function listing(extra = {}) {
  return clipEntryView(JOB, {
    clipId: CLIP, index: 1, openable: true, reason: null,
    edit: { state: "seed", revision: 0, etag: ETAG, updatedAtMs: 1 },
    hook: { on: true, available: true }, latestRender: null, ...extra,
  });
}

function fakeFetch(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const answer = answers[calls.length - 1];
    if (answer instanceof Error) throw answer;
    const [status, body] = answer;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetchImpl };
}

function keys() {
  let next = 0;
  return () => KEYS[next++];
}

test("the copy is short Indonesian without version words", () => {
  assert.equal(HOOK_COPY.label, "Hook di video");
  for (const text of Object.values(HOOK_COPY)) {
    assert.doesNotMatch(text, /—|\bV[0-9]\b|baru|new|versi/i, text);
    assert.ok(text.length <= 80, text);
  }
});

test("the listing entry carries the hook state and the etag the switch saves from", () => {
  const view = listing();
  assert.deepEqual(view.hook, { on: true, available: true });
  assert.equal(view.editEtag, ETAG);
  assert.equal(listing({ hook: { on: "yes", available: true } }).hook, null);
  assert.equal(listing({ edit: null }).editEtag, null);
});

test("the switch shows only for a finished project's clip that has a hook and can be saved", () => {
  assert.deepEqual(hookSwitchView(listing(), { editable: true }), { on: true, clipId: CLIP, etag: ETAG });
  assert.deepEqual(hookSwitchView(listing({ hook: { on: false, available: true } }), { editable: true }),
    { on: false, clipId: CLIP, etag: ETAG });
  assert.equal(hookSwitchView(listing(), { editable: false }), null, "not while the project runs or for a failed clip");
  assert.equal(hookSwitchView(null, { editable: true }), null, "no listing: the editor is off");
  assert.equal(hookSwitchView(listing({ hook: { on: false, available: false } }), { editable: true }), null, "no hook to show");
  assert.equal(hookSwitchView(listing({ hook: null }), { editable: true }), null);
  assert.equal(hookSwitchView(listing({ openable: false, reason: "source_missing" }), { editable: true }), null);
  assert.equal(hookSwitchView(listing({ clipId: null, edit: null, openable: false, reason: "needs_prepare" }), { editable: true }), null);
});

test("a switch saves the document, then exports the new revision", async () => {
  const { calls, fetchImpl } = fakeFetch([
    [200, { etag: NEXT, revision: 1, changed: true, hook: { on: false, available: true } }],
    [202, { renderId: RENDER, state: "queued" }],
  ]);
  const result = await switchHook({ jobId: JOB, clipId: CLIP, etag: ETAG, on: false }, { fetchImpl, uuid: keys() });
  assert.deepEqual(result, { type: "done", hook: { on: false, available: true }, etag: NEXT, exporting: true,
    message: HOOK_COPY.offExporting });
  assert.equal(calls[0].url, `/api/jobs/${JOB}/clips/${CLIP}/hook`);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].init.headers["Idempotency-Key"], KEYS[0]);
  assert.deepEqual(JSON.parse(calls[0].init.body), { on: false, etag: ETAG });
  assert.equal(calls[1].url, `/api/jobs/${JOB}/clips/${CLIP}/renders`);
  assert.equal(calls[1].init.headers["Idempotency-Key"], KEYS[1]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { editEtag: NEXT });
});

test("switching back to the seed's look completes at once (the automatic file)", async () => {
  const { fetchImpl } = fakeFetch([
    [200, { etag: NEXT, revision: 2, changed: true, hook: { on: true, available: true } }],
    [200, { renderId: RENDER, state: "completed" }],
  ]);
  const result = await switchHook({ jobId: JOB, clipId: CLIP, etag: ETAG, on: true }, { fetchImpl, uuid: keys() });
  assert.deepEqual(result, { type: "done", hook: { on: true, available: true }, etag: NEXT, exporting: false, message: HOOK_COPY.onReady });
});

test("a switch to the state the clip already has exports nothing", async () => {
  const { calls, fetchImpl } = fakeFetch([[200, { etag: ETAG, revision: 0, changed: false, hook: { on: true, available: true } }]]);
  const result = await switchHook({ jobId: JOB, clipId: CLIP, etag: ETAG, on: true }, { fetchImpl, uuid: keys() });
  assert.deepEqual(result, { type: "done", hook: { on: true, available: true }, etag: ETAG, exporting: false, message: HOOK_COPY.onReady });
  assert.equal(calls.length, 1);
});

test("the failures the page shows", async () => {
  const conflict = await switchHook({ jobId: JOB, clipId: CLIP, etag: ETAG, on: false },
    { fetchImpl: fakeFetch([[409, { code: "revision_conflict" }]]).fetchImpl, uuid: keys() });
  assert.deepEqual(conflict, { type: "error", code: "revision_conflict", message: HOOK_COPY.conflict });
  const broken = await switchHook({ jobId: JOB, clipId: CLIP, etag: ETAG, on: false },
    { fetchImpl: fakeFetch([[503, { code: "backend_unavailable", error: "x" }]]).fetchImpl, uuid: keys() });
  assert.deepEqual(broken, { type: "error", code: "backend_unavailable", message: HOOK_COPY.failed });
  const offline = await switchHook({ jobId: JOB, clipId: CLIP, etag: ETAG, on: false },
    { fetchImpl: fakeFetch([new TypeError("offline")]).fetchImpl, uuid: keys() });
  assert.deepEqual(offline, { type: "error", code: null, message: HOOK_COPY.failed });
  const malformed = await switchHook({ jobId: JOB, clipId: CLIP, etag: ETAG, on: false },
    { fetchImpl: fakeFetch([[200, { etag: "x" }]]).fetchImpl, uuid: keys() });
  assert.equal(malformed.type, "error");
  const login = await switchHook({ jobId: JOB, clipId: CLIP, etag: ETAG, on: false },
    { fetchImpl: fakeFetch([[401, {}]]).fetchImpl, uuid: keys() });
  assert.deepEqual(login, { type: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${JOB}`)}` });

  // Saved, but the export was refused (storage): the switch keeps its new state and says so.
  const full = await switchHook({ jobId: JOB, clipId: CLIP, etag: ETAG, on: false }, { fetchImpl: fakeFetch([
    [200, { etag: NEXT, revision: 1, changed: true, hook: { on: false, available: true } }],
    [507, { code: "storage_quota_exhausted", error: "Penyimpanan server tidak cukup" }],
  ]).fetchImpl, uuid: keys() });
  assert.deepEqual(full, { type: "done", hook: { on: false, available: true }, etag: NEXT, exporting: false,
    message: HOOK_COPY.exportFailed, warning: true });
  const exportLogin = await switchHook({ jobId: JOB, clipId: CLIP, etag: ETAG, on: false }, { fetchImpl: fakeFetch([
    [200, { etag: NEXT, revision: 1, changed: true, hook: { on: false, available: true } }], [401, {}],
  ]).fetchImpl, uuid: keys() });
  assert.equal(exportLogin.type, "redirect");
});

test("the page polls the listing while an export of a shown clip runs", () => {
  const byIndex = (...entries) => ({ state: "available", byIndex: new Map(entries.map((entry, at) => [at + 1, entry])) });
  const running = listing({ latestRender: { renderId: RENDER, state: "rendering", revision: 1, url: null, srtUrl: null } });
  const queued = listing({ latestRender: { renderId: RENDER, state: "queued", revision: 1, url: null, srtUrl: null } });
  const done = listing({ latestRender: { renderId: RENDER, state: "failed", revision: 1, url: null, srtUrl: null } });
  assert.equal(entriesExporting(byIndex(running)), true);
  assert.equal(entriesExporting(byIndex(done, queued)), true);
  assert.equal(entriesExporting(byIndex(done, listing())), false);
  assert.equal(entriesExporting({ state: "idle", byIndex: new Map() }), false);
  assert.equal(entriesExporting(null), false);
});

test("the project page wires the switch beside the caption's Ubah and Tulis ulang", async () => {
  // The project page's files (page, clips, viewer): the switch sits in the viewer's caption box.
  const page = await projectSource();
  assert.match(page, /<HookSwitch /);
  assert.match(page, /entriesExporting\(entries\)/);
  const caption = page.slice(page.indexOf("<ClipText "), page.indexOf("</section>", page.indexOf("<ClipText ")));
  assert.match(caption, /<HookSwitch /, "inside the caption box, after ClipText");
  const component = await readFile(new URL("../components/HookSwitch.jsx", import.meta.url), "utf8");
  for (const call of ["hookSwitchView(", "switchHook("]) assert.ok(component.includes(call), call);
  assert.match(component, /role="switch"/);
  assert.match(component, /aria-describedby/);
  assert.match(component, /role="status"/);
  assert.match(component, /Enter/, "Enter toggles as well as Space");
  assert.doesNotMatch(component, /dangerouslySetInnerHTML|—/);
  const styles = await readFile(new URL("../components/HookSwitch.module.css", import.meta.url), "utf8");
  assert.match(styles, /min-height: 44px/);
  assert.match(styles, /:focus-visible/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b/i, "colours come from the palette tokens");
});
