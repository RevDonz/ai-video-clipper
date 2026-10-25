// Moving between the project's clips in the editor (the top bar's "Klip 3/8 ‹ ›",
// web/lib/editor/clip-nav.mjs): the order and the neighbours from the clips listing, the address
// that keeps the view, and the save that has to finish before the editor leaves the clip.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createFakeServer, loadContext } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import { ApiError } from "../lib/editor/api-client.mjs";
import { LEAVE_TEXT, clipNavHref, clipNavigation, saveBeforeLeaving } from "../lib/editor/clip-nav.mjs";
import { hookItem } from "../lib/editor/doc-model.mjs";
import { createMemoryDraftStore } from "../lib/editor/draft-store.mjs";
import { createEditorStore } from "../lib/editor/store.mjs";

const JOB = "8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55";
const id = (n) => `clip_${String(n).padStart(24, "0")}`;
const listed = (n, fields = {}) => ({ clipId: id(n), index: n, title: `Klip ${n}`, openable: true, reason: null, ...fields });
const EIGHT = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => listed(n));
const href = (n) => `/projects/${JOB}/clips/${id(n)}/edit`;

// --- order and neighbours ----------------------------------------------------------------------

test("the clip's place among the project's clips: 'Klip 3/8', with the clips before and after it", () => {
  assert.deepEqual(clipNavigation({ jobId: JOB, clipId: id(3), clips: EIGHT }), {
    position: 3, total: 8, previous: { href: href(2), position: 2 }, next: { href: href(4), position: 4 },
  });
});

test("the order is the clip number, as on the project page, whatever order the listing has", () => {
  const shuffled = [EIGHT[4], EIGHT[0], EIGHT[7], EIGHT[2], EIGHT[6], EIGHT[1], EIGHT[5], EIGHT[3]];
  const nav = clipNavigation({ jobId: JOB, clipId: id(5), clips: shuffled });
  assert.equal(nav.position, 5);
  assert.equal(nav.previous.href, href(4));
  assert.equal(nav.next.href, href(6));
});

test("‹ has no target on the first clip and › none on the last", () => {
  const first = clipNavigation({ jobId: JOB, clipId: id(1), clips: EIGHT });
  assert.equal(first.position, 1);
  assert.equal(first.previous, null);
  assert.equal(first.next.href, href(2));
  const last = clipNavigation({ jobId: JOB, clipId: id(8), clips: EIGHT });
  assert.equal(last.position, 8);
  assert.equal(last.previous.href, href(7));
  assert.equal(last.next, null);
});

test("a clip the editor cannot open is skipped; one it prepares on open is a target, by number when it has no id", () => {
  const clips = EIGHT.map((clip) => {
    if (clip.index === 4) return { ...clip, openable: false, reason: "source_unreadable" };
    if (clip.index === 5) return { ...clip, clipId: null, openable: false, reason: "needs_prepare" };
    if (clip.index === 2) return { ...clip, openable: false, reason: "transcript_missing" };
    if (clip.index === 1) return { ...clip, openable: false, reason: "analysis_incomplete" };
    return clip;
  });
  const nav = clipNavigation({ jobId: JOB, clipId: id(3), clips });
  assert.equal(nav.position, 3);
  assert.equal(nav.total, 8);
  assert.deepEqual(nav.next, { href: `/projects/${JOB}/clips/klip-5/edit`, position: 5 });
  assert.deepEqual(nav.previous, { href: href(1), position: 1 });
  const closed = EIGHT.map((clip) => (clip.index === 3 ? clip : { ...clip, openable: false, reason: "source_missing" }));
  assert.deepEqual(clipNavigation({ jobId: JOB, clipId: id(3), clips: closed }),
    { position: 3, total: 8, previous: null, next: null });
});

test("no navigation for a single clip, a clip the listing does not name, or no listing", () => {
  assert.equal(clipNavigation({ jobId: JOB, clipId: id(1), clips: [listed(1)] }), null);
  assert.equal(clipNavigation({ jobId: JOB, clipId: id(9), clips: EIGHT }), null);
  assert.equal(clipNavigation({ jobId: JOB, clipId: null, clips: EIGHT }), null);
  assert.equal(clipNavigation({ jobId: JOB, clipId: id(3), clips: null }), null);
  assert.equal(clipNavigation({ jobId: JOB, clipId: id(3), clips: [null, "x", ...EIGHT.slice(0, 3)] }).total, 3);
});

test("a listed id that is not a clip id never becomes an address", () => {
  const clips = [listed(1, { clipId: "../../settings" }), listed(2), listed(3, { clipId: "clip_x/edit" })];
  const nav = clipNavigation({ jobId: JOB, clipId: id(2), clips });
  assert.equal(nav.previous, null);
  assert.equal(nav.next, null);
});

// --- the neighbour's address ---------------------------------------------------------------------

test("the neighbour opens in the same view, with Lengkap's panel or Cepat's open card", () => {
  assert.equal(clipNavHref(href(4), { view: "lengkap", panel: "text", card: "hook" }), `${href(4)}?mode=lengkap&panel=text`);
  assert.equal(clipNavHref(href(4), { view: "cepat", panel: "text", card: "hook" }), `${href(4)}?mode=cepat&card=hook`);
  assert.equal(clipNavHref(href(4), { view: "cepat", card: null }), `${href(4)}?mode=cepat`);
  assert.equal(clipNavHref(href(4), { view: "lengkap", panel: "nope" }), `${href(4)}?mode=lengkap`);
  assert.equal(clipNavHref(href(4), {}), href(4));
  assert.equal(clipNavHref(`${href(4)}?mode=cepat#x`, { view: "lengkap" }), `${href(4)}?mode=lengkap`);
});

// --- saving before the editor leaves the clip -----------------------------------------------------

const C30 = loadContext("c30");
let keys = 0;

function realStore(server = createFakeServer(C30)) {
  const store = createEditorStore({
    jobId: server.jobId, clipId: server.clipId, api: server.api, previewClient: null, draftStore: createMemoryDraftStore(),
    newKey: () => `00000000-0000-4000-8000-${String((keys += 1)).padStart(12, "0")}`,
    // Autosave never fires by itself here: only the leave's flush saves.
    timers: { setTimeout: () => 0, clearTimeout: () => {} }, channel: null, lifecycle: null,
  });
  return { store, server };
}

const leave = (store, options = {}) => saveBeforeLeaving({ flush: () => store.flush(), getState: () => store.getState(), ...options });

test("nothing to save: the editor may leave at once, without a PUT", async () => {
  const { store, server } = realStore();
  await store.ready;
  assert.deepEqual(await leave(store), { ok: true });
  assert.equal(server.puts.length, 0);
  store.destroy();
});

test("pending work is saved first; the editor leaves only once the server has it", async () => {
  const { store, server } = realStore();
  await store.ready;
  store.dispatch("SetHookText", { text: "Hook dari editor ini" });
  assert.equal(store.getState().save, "dirty");
  assert.deepEqual(await leave(store), { ok: true });
  assert.equal(server.puts.length, 1);
  assert.equal(hookItem(server.doc).payload.text, "Hook dari editor ini");
  assert.equal(store.getState().save, "saved");
  store.destroy();
});

test("a failed save keeps the editor on the clip with the save error shown and the work kept", async () => {
  const { store, server } = realStore();
  await store.ready;
  server.failures.push(new ApiError(503, "backend_unavailable", {}));
  store.dispatch("SetHookText", { text: "Belum tersimpan" });
  assert.deepEqual(await leave(store), { ok: false, reason: "error" });
  const state = store.getState();
  assert.equal(state.save, "error");
  assert.equal(state.error.message, "Gagal menyimpan; perubahan aman di browser ini");
  assert.equal(state.commands.length, 1, "the edit is still pending");
  store.destroy();
});

test("a conflict with another tab keeps the editor on the clip with the conflict dialog's state", async () => {
  const { store, server } = realStore();
  await store.ready;
  store.dispatch("SetHookText", { text: "Punyaku" });
  server.otherTab([["SetHookText", { text: "Tersimpan" }]]);
  assert.deepEqual(await leave(store), { ok: false, reason: "conflict" });
  const state = store.getState();
  assert.equal(state.save, "conflict");
  assert.deepEqual(state.conflict.groups.map((group) => group.label), ["Teks hook"]);
  assert.equal(hookItem(state.doc).payload.text, "Punyaku");
  // While the dialog waits for an answer, another try stays put without a new PUT.
  const puts = server.puts.length;
  assert.deepEqual(await leave(store), { ok: false, reason: "conflict" });
  assert.equal(server.puts.length, puts);
  store.destroy();
});

test("a conflict that merges by itself is saved, then the editor leaves", async () => {
  const { store, server } = realStore();
  await store.ready;
  store.dispatch("SetHookText", { text: "Hook dari tab ini" });
  server.otherTab([["SetLayout", { mode: "camera" }]]);
  assert.deepEqual(await leave(store), { ok: true });
  assert.equal(store.getState().save, "saved");
  assert.equal(hookItem(server.doc).payload.text, "Hook dari tab ini");
  assert.equal(server.doc.layout.default.mode, "camera");
  store.destroy();
});

test("a store that answers the flush but still shows an error or a conflict is not left", async () => {
  for (const save of ["error", "conflict"]) {
    let flushes = 0;
    const result = await saveBeforeLeaving({ flush: async () => { flushes += 1; }, getState: () => ({ save }) });
    assert.deepEqual(result, { ok: false, reason: save }, save);
    assert.ok(flushes <= 1, save);
  }
});

test("work that arrived while saving is saved in a further round", async () => {
  const states = ["dirty", "dirty", "saved"];
  let flushes = 0;
  const result = await saveBeforeLeaving({
    flush: async () => { flushes += 1; },
    getState: () => ({ save: flushes >= 2 ? states[2] : states[flushes] }),
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(flushes, 2);
  let endless = 0;
  assert.deepEqual(await saveBeforeLeaving({ flush: async () => { endless += 1; }, getState: () => ({ save: "dirty" }) }),
    { ok: false, reason: "error" });
  assert.ok(endless >= 2 && endless <= 5, "a bounded number of rounds");
});

test("while an export is being saved or sent, the editor stays and nothing is flushed", async () => {
  for (const exportPhase of ["saving", "submitting"]) {
    let flushes = 0;
    const result = await saveBeforeLeaving({ flush: async () => { flushes += 1; }, getState: () => ({ save: "saved" }), exportPhase });
    assert.deepEqual(result, { ok: false, reason: "export" }, exportPhase);
    assert.equal(flushes, 0);
  }
  for (const exportPhase of [null, "idle", "running", "completed", "failed"]) {
    assert.deepEqual(await saveBeforeLeaving({ flush: async () => {}, getState: () => ({ save: "saved" }), exportPhase }), { ok: true });
  }
});

test("each reason to stay has short Indonesian text without an em dash", () => {
  assert.deepEqual(Object.keys(LEAVE_TEXT).sort(), ["conflict", "error", "export"]);
  for (const text of Object.values(LEAVE_TEXT)) {
    assert.ok(text.length > 10 && text.length <= 80, text);
    assert.ok(!text.includes(String.fromCharCode(0x2014)), text);
  }
});

// --- the shell's wiring (component sources) --------------------------------------------------------

const editorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "components", "editor");
const read = (...parts) => readFileSync(path.join(editorDir, ...parts), "utf8");

test("the top bar shows 'Klip n/total' and the ‹ › buttons with names, shortcuts and their disabled ends", () => {
  const bar = read("TopBar.jsx");
  assert.match(bar, /role="group" aria-label="Pindah klip"/);
  assert.match(bar, /`Klip \$\{clipNav\.position\}\/\$\{clipNav\.total\}`/);
  assert.match(bar, /`Klip \$\{clipNav\.position\} dari \$\{clipNav\.total\}`/);
  assert.match(bar, /aria-label="Klip sebelumnya"[\s\S]*?aria-keyshortcuts="Control\+Shift\+ArrowLeft"/);
  assert.match(bar, /aria-label="Klip berikutnya"[\s\S]*?aria-keyshortcuts="Control\+Shift\+ArrowRight"/);
  assert.match(bar, /disabled=\{!clipNav\.previous\}/);
  assert.match(bar, /disabled=\{!clipNav\.next\}/);
  // The group sits right after "← Proyek", before the title.
  assert.ok(bar.indexOf("Pindah klip") > bar.indexOf("← Proyek"));
  assert.ok(bar.indexOf("Pindah klip") < bar.indexOf("className={styles.titleBlock}"));
});

test("the shell saves through saveBeforeLeaving before it opens the neighbour, and never otherwise", () => {
  const app = read("EditorApp.jsx");
  // ‹ › (goToClip) and the one-layout editor's Klip list both leave through openClip.
  const go = /const openClip = useCallback\(async \(href\) => \{([\s\S]*?)\n {2}\}, \[/.exec(app)?.[1] ?? "";
  assert.ok(go, "openClip");
  const saved = go.indexOf("await saveBeforeLeaving(");
  const assign = go.indexOf("window.location.assign(");
  assert.ok(saved > 0 && assign > saved, "the save is awaited before the page is left");
  assert.match(go, /if \(result\.ok\) \{\s*window\.location\.assign\(neighbourHref\(href\)\)/);
  assert.match(go, /notify\(LEAVE_TEXT\[result\.reason\]\)/);
  // The old views open the neighbour in the same view (clipNavHref), the one-layout editor on the same tab.
  assert.match(app, /const neighbourHref = useCallback\(\(href\) => \(oneLayout \? panelHref\(href, tabId\)\s*: clipNavHref\(href, \{ view, panel: panelId, card: cardRef\.current \}\)\)/);
  assert.match(/const goToClip = useCallback\(\(side\) => \{([\s\S]*?)\n {2}\}, \[/.exec(app)?.[1] ?? "", /if \(target\) openClip\(target\.href\);/);
  assert.match(app, /onOpen=\{\(row\) => openClip\(row\.href\)\}/);
  assert.equal(app.match(/window\.location\.assign\(/g).length, 2, "the login redirect and the neighbour, no other");
  assert.match(app, /previousClip: \(\) => goToClip\("previous"\)/);
  assert.match(app, /nextClip: \(\) => goToClip\("next"\)/);
  assert.match(/<TopBar\s([\s\S]*?)\/>/.exec(app)?.[1] ?? "", /\bclipNav=\{clipNav\}/);
});
