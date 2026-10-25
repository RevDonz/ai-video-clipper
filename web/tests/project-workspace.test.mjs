// The project page as a workspace (plan P1 #7): poster grid + one detail panel, the "Semua" and
// "Skor 8+" filters, left/right arrows between clips, and "Pilih" mode for the ZIP download.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { projectSource } from "./support/screen-sources.mjs";

import { CLIP_FALLBACKS } from "../lib/jobs.mjs";
import {
  arrowDelta,
  checkZip,
  clipFallbackNotes,
  clipFilterView,
  clipPosition,
  editedIndexes,
  filterEmptyText,
  isHighScore,
  keepSelection,
  pickAll,
  pickSummary,
  pickedInOrder,
  prunePicks,
  scorePill,
  stepSelection,
  togglePick,
} from "../lib/project-workspace.mjs";
import { textsOf } from "./support/catalog-t.mjs";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const scored = (index, score) => ({ index, score, selectionSource: "llm", title: `Klip ${index}` });
const CLIPS = [scored(1, 8.4), scored(2, 6.1), scored(3, 7.95), scored(4, 9), scored(5, 7.94)];
const indexes = (clips) => clips.map((clip) => clip.index);

test("the score pill shows the total with one decimal and marks 8 and up; old clips get none", () => {
  assert.deepEqual(scorePill(scored(1, 8.4)), { text: "8,4", high: true });
  assert.deepEqual(scorePill(scored(1, 8)), { text: "8,0", high: true });
  // The mark follows the number the pill shows: 7,95 reads "8,0", 7,94 reads "7,9".
  assert.deepEqual(scorePill(scored(1, 7.95)), { text: "8,0", high: true });
  assert.deepEqual(scorePill(scored(1, 7.94)), { text: "7,9", high: false });
  assert.deepEqual(scorePill(scored(1, 0)), { text: "0,0", high: false });
  for (const clip of [{ index: 1, score: 9 }, { ...scored(1, 9), selectionSource: "v1" }, scored(1, 13), scored(1, null), null]) {
    assert.equal(scorePill(clip), null, JSON.stringify(clip));
    assert.equal(isHighScore(clip), false);
  }
});

test("'Semua' shows every clip; 'Skor 8+' only the clips whose pill is marked", () => {
  const all = clipFilterView(CLIPS, "all");
  assert.deepEqual(all.filters, [
    { value: "all", label: "Semua", count: 5, active: true },
    { value: "high", label: "Skor 8+", count: 3, active: false },
  ]);
  assert.deepEqual(indexes(all.visible), [1, 2, 3, 4, 5]);
  assert.equal(all.showFilters, true);
  const high = clipFilterView(CLIPS, "high");
  assert.deepEqual(indexes(high.visible), [1, 3, 4]);
  assert.deepEqual(high.filters.map((item) => item.active), [false, true]);
  // An unknown filter reads as "Semua".
  assert.deepEqual(indexes(clipFilterView(CLIPS, "hot").visible), [1, 2, 3, 4, 5]);
  // A project whose clips have no score (made before the current selection) shows no filter.
  const old = clipFilterView([{ index: 1, score: 13 }, { index: 2 }], "high");
  assert.equal(old.showFilters, false);
  assert.deepEqual(indexes(old.visible), [1, 2]);
  assert.deepEqual(clipFilterView(null, "all").visible, []);
  // No word on screen calls a score hot or viral.
  for (const item of all.filters) assert.doesNotMatch(item.label, /hot|viral/i);
});

test("'Diedit' shows the clips the editor changed, beside 'Semua' and 'Skor 8+'", () => {
  const edited = new Set([2, 4]);
  const all = clipFilterView(CLIPS, "all", edited);
  assert.deepEqual(all.filters, [
    { value: "all", label: "Semua", count: 5, active: true },
    { value: "high", label: "Skor 8+", count: 3, active: false },
    { value: "edited", label: "Diedit", count: 2, active: false },
  ]);
  const view = clipFilterView(CLIPS, "edited", edited);
  assert.deepEqual(indexes(view.visible), [2, 4]);
  assert.deepEqual(view.filters.map((item) => item.active), [false, false, true]);
  assert.equal(view.active, "edited");
  // No edited clip yet: the chip stays with 0, and the grid is empty (the page says why).
  const none = clipFilterView(CLIPS, "edited", new Set());
  assert.deepEqual(none.filters.at(-1), { value: "edited", label: "Diedit", count: 0, active: true });
  assert.deepEqual(none.visible, []);
  // Without the editor listing (off, loading, failed) there is no chip, and "Diedit" reads as "Semua".
  const unknown = clipFilterView(CLIPS, "edited", null);
  assert.deepEqual(unknown.filters.map((item) => item.value), ["all", "high"]);
  assert.equal(unknown.active, "all");
  assert.deepEqual(indexes(unknown.visible), [1, 2, 3, 4, 5]);
  // Clips without a score (an older selection) still get "Semua" and "Diedit", without "Skor 8+".
  const unscored = [{ index: 1 }, { index: 2 }];
  const old = clipFilterView(unscored, "high", new Set([2]));
  assert.equal(old.showFilters, true);
  assert.deepEqual(old.filters.map((item) => item.value), ["all", "edited"]);
  assert.deepEqual(indexes(old.visible), [1, 2]);
  assert.deepEqual(indexes(clipFilterView(unscored, "edited", new Set([2])).visible), [2]);
  assert.deepEqual(clipFilterView([], "edited", new Set()).visible, []);
});

test("the edited clips come from the same entry that shows the 'Diedit' badge", () => {
  const entry = (tone, editHref = "/edit") => ({ editHref, editBadge: tone ? { text: "x", tone } : null });
  const entries = new Map([[1, entry("edited")], [2, entry("muted")], [3, null], [4, entry("edited")]]);
  assert.deepEqual([...editedIndexes(CLIPS, (clip) => entries.get(clip.index) ?? null)], [1, 4]);
  // Some clip can open in the editor, none changed yet: an empty set, so the chip shows 0.
  assert.deepEqual([...editedIndexes(CLIPS, (clip) => (clip.index === 2 ? entry("muted") : null))], []);
  // No editor entry at all (listing off or still loading), or none that can open: no chip.
  assert.equal(editedIndexes(CLIPS, () => null), null);
  assert.equal(editedIndexes(CLIPS, () => entry(null, null)), null);
  assert.equal(editedIndexes([], () => entry("edited")), null);
  assert.equal(editedIndexes(null, () => entry("edited")), null);
});

test("'Di luar fokus' shows the clips outside a project's focus, only when there is one", async () => {
  const { clipFilterView: view } = await import("../lib/project-workspace.mjs");
  assert.equal(view(CLIPS, "all").filters.some((item) => item.value === "outsideFocus"), false, "no focus: no chip");
  assert.equal(view(CLIPS, "all", null, new Set()).filters.some((item) => item.value === "outsideFocus"), false, "every clip matched");
  const outside = view(CLIPS, "outsideFocus", null, new Set([2, 5]));
  assert.equal(outside.active, "outsideFocus");
  assert.deepEqual(indexes(outside.visible), [2, 5]);
  assert.deepEqual(outside.filters.map((item) => [item.value, item.count]), [["all", 5], ["high", 3], ["outsideFocus", 2]]);
});

test("Terbaik sorts by the shown score, Urutan video by where the clip starts; ties keep the number order", async () => {
  const { sortClips } = await import("../lib/project-workspace.mjs");
  assert.deepEqual(indexes(sortClips(CLIPS, "best")), [4, 1, 3, 5, 2]);
  const timed = [{ index: 1, sourceStart: 300 }, { index: 2, sourceStart: 20 }, { index: 3, start: 100 }, { index: 4 }];
  assert.deepEqual(indexes(sortClips(timed, "timeline")), [2, 3, 1, 4]);
  // Unscored (old) clips keep their number order under Terbaik, after any scored one.
  assert.deepEqual(indexes(sortClips([{ index: 2 }, scored(3, 7), { index: 1 }], "best")), [3, 1, 2]);
  const original = [...CLIPS];
  sortClips(CLIPS, "best");
  assert.deepEqual(CLIPS, original, "the job's list is not changed");
  assert.deepEqual(sortClips(null, "best"), []);
});

test("?klip=N is set and cleared without touching the rest of the query", async () => {
  const { withClipParam } = await import("../lib/project-workspace.mjs");
  assert.equal(withClipParam("", 3), "?klip=3");
  assert.equal(withClipParam("?klip=2&x=1", 4), "?klip=4&x=1");
  assert.equal(withClipParam("?klip=2&x=1", null), "?x=1");
  assert.equal(withClipParam("?klip=2", null), "");
  assert.equal(withClipParam("", 0), "");
});

test("an empty filter says which clips are missing", () => {
  assert.equal(filterEmptyText("high"), "Belum ada klip dengan skor 8 atau lebih.");
  assert.equal(filterEmptyText("edited"), "Belum ada klip yang diedit.");
  assert.equal(filterEmptyText("all"), "Belum ada klip.");
});

test("the selected clip stays while it is shown, else the first shown clip takes its place", () => {
  const visible = CLIPS.filter((clip) => [1, 3, 4].includes(clip.index));
  assert.equal(keepSelection(visible, 3), 3);
  assert.equal(keepSelection(visible, 2), 1);
  assert.equal(keepSelection(visible, null), 1);
  assert.equal(keepSelection([], 3), null);
});

test("the arrows step through the shown clips and stop at both ends", () => {
  const visible = CLIPS.filter((clip) => [1, 3, 4].includes(clip.index));
  assert.equal(stepSelection(visible, 1, 1), 3);
  assert.equal(stepSelection(visible, 3, 1), 4);
  assert.equal(stepSelection(visible, 4, 1), 4);
  assert.equal(stepSelection(visible, 1, -1), 1);
  assert.equal(stepSelection(visible, 4, -1), 3);
  assert.equal(stepSelection(visible, 2, 1), 3, "a hidden selection steps from the first shown clip");
  assert.equal(stepSelection([], 1, 1), null);
  assert.deepEqual(clipPosition(visible, 3), { position: 2, total: 3, first: false, last: false });
  assert.deepEqual(clipPosition(visible, 1), { position: 1, total: 3, first: true, last: false });
  assert.deepEqual(clipPosition(visible, 4), { position: 3, total: 3, first: false, last: true });
  assert.equal(clipPosition([], 1), null);
});

test("left and right move between clips unless a control that uses them has the focus", () => {
  const key = (code, target = { tagName: "BODY" }, extra = {}) => arrowDelta({ key: code, target, ...extra });
  assert.equal(key("ArrowRight"), 1);
  assert.equal(key("ArrowLeft"), -1);
  assert.equal(key("ArrowRight", { tagName: "BUTTON" }), 1);
  assert.equal(key("ArrowLeft", { tagName: "A" }), -1);
  assert.equal(key("ArrowUp"), 0);
  assert.equal(key("Enter"), 0);
  for (const target of [
    { tagName: "INPUT", type: "text" }, { tagName: "INPUT", type: "range" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" },
    { tagName: "VIDEO" }, { tagName: "AUDIO" }, { tagName: "DIV", isContentEditable: true }, { tagName: "DIV", role: "slider" },
  ]) assert.equal(key("ArrowRight", target), 0, JSON.stringify(target));
  for (const modifier of ["altKey", "ctrlKey", "metaKey", "shiftKey", "defaultPrevented", "isComposing"]) {
    assert.equal(key("ArrowRight", { tagName: "BODY" }, { [modifier]: true }), 0, modifier);
  }
  assert.equal(arrowDelta(null), 0);
  assert.equal(arrowDelta({ key: "ArrowRight", target: null }), 1);
});

test("'Pilih' mode toggles clips, picks every shown clip and keeps only shown clips picked", () => {
  let picks = new Set();
  picks = togglePick(picks, 3);
  picks = togglePick(picks, 1);
  assert.deepEqual([...picks].sort(), [1, 3]);
  picks = togglePick(picks, 3);
  assert.deepEqual([...picks], [1]);
  const visible = CLIPS.filter((clip) => [1, 3, 4].includes(clip.index));
  assert.deepEqual([...pickAll(visible)].sort(), [1, 3, 4]);
  assert.deepEqual([...prunePicks(new Set([1, 2, 4]), visible)].sort(), [1, 4]);
  // The ZIP keeps the project's order, whatever order the clips were picked in.
  assert.deepEqual(pickedInOrder(CLIPS, new Set([4, 1, 3])), [1, 3, 4]);
  assert.deepEqual(pickedInOrder(CLIPS, new Set()), []);
  assert.equal(pickSummary(0), "0 dipilih");
  assert.equal(pickSummary(3), "3 dipilih");
});

test("before the ZIP downloads, the page asks the route whether it can be made", async () => {
  const calls = [];
  const answer = (status, body) => async (url, options) => {
    calls.push({ url, options });
    return Response.json(body, { status });
  };
  const ok = await checkZip(JOB_ID, [1, 3], { fetchImpl: answer(200, { count: 2, bytes: 3_000_000, filename: "proyek-klip.zip" }) });
  assert.deepEqual(ok, { type: "ok", count: 2, bytes: 3_000_000, filename: "proyek-klip.zip", href: `/api/jobs/${JOB_ID}/zip?clips=1%2C3` });
  assert.equal(calls[0].url, `/api/jobs/${JOB_ID}/zip?clips=1%2C3&check=1`);
  assert.equal(calls[0].options.cache, "no-store");

  const all = await checkZip(JOB_ID, null, { fetchImpl: answer(200, { count: 5, bytes: 9, filename: "x.zip" }) });
  assert.equal(all.href, `/api/jobs/${JOB_ID}/zip`);

  const tooLarge = await checkZip(JOB_ID, null, { fetchImpl: answer(413, { error: "ZIP-nya 2,4 GB, batasnya 2 GB.", code: "zip_too_large" }) });
  assert.deepEqual(tooLarge, { type: "error", message: "ZIP-nya 2,4 GB, batasnya 2 GB." });
  const expired = await checkZip(JOB_ID, [2], { fetchImpl: answer(401, { error: "x" }) });
  assert.deepEqual(expired, { type: "redirect", location: `/login?next=${encodeURIComponent(`/projects/${JOB_ID}`)}` });
  const odd = await checkZip(JOB_ID, null, { fetchImpl: answer(200, { count: "dua" }) });
  assert.equal(odd.type, "error");
  const broken = await checkZip(JOB_ID, null, { fetchImpl: async () => new Response("<html>", { status: 502 }) });
  assert.deepEqual(broken, { type: "error", message: "ZIP tidak bisa disiapkan. Coba lagi sebentar lagi." });
  const offline = await checkZip(JOB_ID, null, { fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  assert.deepEqual(offline, { type: "error", message: "ZIP tidak bisa disiapkan. Periksa koneksi, lalu coba lagi." });
  const aborted = Object.assign(new Error("aborted"), { name: "AbortError" });
  await assert.rejects(checkZip(JOB_ID, null, { fetchImpl: async () => { throw aborted; } }), (error) => error === aborted);
});

test("fallback notes: one short neutral line per code; only the framing note goes on the poster", () => {
  assert.deepEqual(textsOf(clipFallbackNotes({ fallbacks: ["no_face", "engine_fallback"] })), [
    { code: "no_face", card: "Potong tengah", text: "Wajah tidak terdeteksi · potong tengah" },
    { code: "engine_fallback", card: null, text: "Dirender dengan cara cadangan" },
  ]);
  assert.deepEqual(clipFallbackNotes({ fallbacks: ["engine_fallback", "no_face"] }).map((note) => note.code), ["no_face", "engine_fallback"]);
  for (const clip of [{}, { fallbacks: [] }, { fallbacks: ["tight_cut"] }, { fallbacks: "no_face" }, null, undefined]) {
    assert.deepEqual(clipFallbackNotes(clip), [], JSON.stringify(clip));
  }
  // Every code the job API serves has its note.
  for (const code of CLIP_FALLBACKS) assert.equal(clipFallbackNotes({ fallbacks: [code] }).length, 1, code);
});

// The project page's files (page, ClipsSection, ClipViewer, ...): Dashboard F3 split the page into
// the clips section and the clip viewer (05-ui-dashboard.md §6.4).
const page = () => projectSource();
const stylesheet = () => readFile(new URL("../app/projects/[id]/project.module.css", import.meta.url), "utf8");
const viewerStylesheet = () => readFile(new URL("../components/ClipViewer.module.css", import.meta.url), "utf8");

test("the page: one poster button per clip that opens the viewer, a toggle in 'Pilih'", async () => {
  const source = await page();
  assert.match(source, /<ul className=\{styles\.posterGrid\} aria-label=\{t\("clips\.list"\)\}/);
  assert.match(source, /<article className=\{styles\.poster\} aria-labelledby=\{titleId\}/);
  // Outside Pilih a poster opens the clip viewer (a dialog), so it says so; Tab reaches each one.
  assert.match(source, /aria-haspopup=\{picking \? undefined : "dialog"\}/);
  assert.doesNotMatch(source, /tabIndex=\{selected/);
  // A clip that failed to render is no toggle in 'Pilih': it has no file to zip.
  assert.match(source, /const pickable = picking && !failed;/);
  assert.match(source, /aria-pressed=\{pickable \? picked : undefined\}/);
  assert.match(source, /aria-disabled=\{picking && failed \? "true" : undefined\}/);
  assert.match(source, /if \(!isFailedClip\(clips\.find\(\(clip\) => clip\.index === index\)\)\) setPicks/);
  assert.match(source, /const pill = scorePill\(clip\);/);
  // The poster itself is the shared one the Riwayat clip grid draws too.
  assert.match(source, /<PosterThumb poster=\{clipPosterUrl\(clip\)\} number=\{number\} length=\{length\}\n\s*badge=\{failed && /);
  assert.match(source, /\{pickable && <span className=\{styles\.check\} aria-hidden="true" \/>\}/);
  assert.match(source, /<PosterText titleId=\{titleId\} title=\{clip\.title \|\| clipLabel\(clip\)\} pill=\{pill\} edited=\{edited\}\n\s*flags=\{cardNotes\.map\(/);
  const poster = await readFile(new URL("../components/ClipPoster.jsx", import.meta.url), "utf8");
  // The page's fallback notes sit on the shared poster's meta row, beside the score pill.
  assert.match(poster, /\{\(pill \|\| edited \|\| hasFlags\) && \(/);
  assert.match(poster, /\{hasFlags && flags\}/);
  assert.match(poster, /data-high=\{pill\.high \|\| undefined\}>\{pill\.high && <i \/>\}\{pill\.text\}/);
  // Poster images are decoration: the title beside them names the clip.
  assert.match(poster, /<img src=\{poster\} alt="" loading="lazy" decoding="async" \/>/);
});

test("the page: one-of filters, the arrows step the shown clips in the viewer, Escape leaves 'Pilih'", async () => {
  const source = await page();
  assert.match(source, /<ToggleButtonGroup aria-label=\{t\("filter\.label"\)\} disallowEmptySelection selectedKeys=\{\[view\.active\]\}/);
  assert.match(source, /if \(key\) changeFilter\(String\(key\)\);/);
  // "Diedit" counts the clips whose entry shows the badge; an empty filter says which clips are missing.
  assert.match(source, /const edited = editedIndexes\(clips, entryFor\);/);
  assert.match(source, /const view = clipFilterView\(sortClips\(clips, sort\), filter, edited, outside\);/);
  assert.match(source, /prunePicks\(previous, clipFilterView\(clips, value, edited, outside\)\.visible\)/);
  assert.match(source, /<span>\{emptyText\[view\.active\]\}<\/span>/);
  // The viewer steps through the clips the grid shows, in its order.
  assert.match(source, /<ClipViewer job=\{job\} clips=\{visible\}/);
  assert.match(source, /const delta = arrowDelta\(event\);/);
  assert.match(source, /const next = clips\[at \+ delta\];/);
  assert.match(source, /event\.key === "Escape" && !event\.defaultPrevented\) stopPicking\(\)/);
  assert.match(source, /document\.addEventListener\("keydown", listener\)/);
  assert.match(source, /document\.removeEventListener\("keydown", listener\)/);
  assert.match(source, /aria-label=\{tAria\("prev"\)\}/);
  assert.match(source, /aria-label=\{tAria\("next"\)\}/);
});

test("the page: 'Pilih' reads 'n dipilih · Pilih semua · Batal · Unduh (n)'; 'Unduh semua' heads the page", async () => {
  const source = await page();
  for (const key of ['t("select")', 't("bulk.all")', 't("bulk.cancel")', 't("downloadAll")']) assert.ok(source.includes(key), key);
  const id = JSON.parse(await readFile(new URL("../messages/id/project.json", import.meta.url), "utf8"));
  assert.deepEqual([id.select, id.bulk.all, id.bulk.cancel, id.downloadAll, id.bulk.count, id.bulk.download],
    ["Pilih", "Pilih semua", "Batal", "Unduh semua", "{count} dipilih", "Unduh ({n})"]);
  assert.match(source, /\{t\("bulk\.count", \{ count: picks\.size \}\)\}/);
  assert.match(source, /\{t\("bulk\.download", \{ n: picks\.size \}\)\}/);
  // While the ZIP is checked the buttons are pending (they keep the keyboard focus); download()
  // ignores a second press.
  assert.match(source, /<Button variant="primary" isDisabled=\{!picks\.size\} isPending=\{busy\}/);
  assert.match(source, /onPress=\{async \(\) => \{ if \(await onDownload\(pickedInOrder\(clips, picks\)\)\) stopPicking\(\); \}\}/);
  assert.match(source, /isPending=\{zip\.state === "checking"\} onPress=\{\(\) => download\(null\)\}>\s*\{t\("downloadAll"\)\}/);
  assert.match(source, /const download = async \(indexes\) => \{\n\s*if \(zip\.state === "checking"\) return false;/);
  assert.match(source, /result = await checkZip\(job\.id, indexes, \{ signal: controller\.signal \}\);/);
  assert.match(source, /role="alert">\{zip\.message\}/);
  // The ZIP buttons only on a finished project with a clip that rendered.
  assert.match(source, /const downloadable = job\.status === "completed" && readyClips\(clips\)\.length > 0;/);
  assert.match(source, /const downloadable = job\.status === "completed" && readyClips\(job\.clips\)\.length > 0;/);
});

test("the page: the framing note on its poster (and in its label), every note in the viewer", async () => {
  const source = await page();
  assert.match(source, /const cardNotes = clipFallbackNotes\(clip\)\.filter\(\(note\) => note\.card\)\.map\(\(note\) => \(\{ \.\.\.note, card: msg\(tAll, note\.card\) \}\)\);/);
  assert.match(source, /\.\.\.cardNotes\.map\(\(note\) => note\.card\.toLowerCase\(\)\)/);
  assert.match(source, /\{cardNotes\.map\(\(note\) => <span key=\{note\.code\} className=\{styles\.posterNote\}>\{note\.card\}<\/span>\)\}/);
  assert.match(source, /const notes = clipFallbackNotes\(clip\);/);
  assert.match(source, /<ul className=\{styles\.clipNotes\} aria-label=\{t\("viewer\.notes"\)\}>/);
  // Neutral: muted text, no colour or badge of its own.
  for (const [css, rule] of [[await stylesheet(), "posterNote"], [await viewerStylesheet(), "clipNotes"]]) {
    const block = new RegExp(`\\.${rule} \\{([^}]*)\\}`).exec(css)?.[1] || "";
    assert.match(block, /color: var\(--text-muted\);/, rule);
    assert.doesNotMatch(block, /background|border/, rule);
  }
});

test("the page and its view model never call a score hot or viral", async () => {
  for (const source of [await page(), await readFile(new URL("../lib/project-workspace.mjs", import.meta.url), "utf8")]) {
    const text = source.replace(/^import [\s\S]*?;$/gm, "").replace(/\/\/.*$/gm, "");
    assert.doesNotMatch(text, /\bhot\b|viral/i);
  }
});

test("phones get one column in the viewer, posters two across, and 44 px targets for every control", async () => {
  const css = await stylesheet();
  const phone = /@media \(max-width: 720px\) \{([\s\S]*?)\n\}/.exec(css)?.[1] || "";
  assert.match(phone, /\.posterGrid \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  const viewer = await viewerStylesheet();
  const compact = /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/.exec(viewer)?.[1] || "";
  assert.match(compact, /\.body \{ grid-template-columns: minmax\(0, 1fr\); \}/);
  // The filters and the viewer's arrows are HeroUI ToggleButtons and Buttons: 44 px in app/ui.css.
  const kit = await readFile(new URL("../app/ui.css", import.meta.url), "utf8");
  assert.match(kit, /\.button, \.tabs__tab, \.menu-item, \.list-box-item, \.close-button,\s*\.toggle-button, [^{]*\{ min-height: 44px; min-width: 44px; \}/);
  const source = await page();
  assert.match(source, /<ToggleButton key=\{item\.value\} id=\{item\.value\}>/);
  assert.match(source, /<Button variant="ghost" isIconOnly aria-label=\{tAria\("prev"\)\}/);
});

// ClipText and HookSwitch sit side by side in the caption box and each is keyed by the clip, so
// showing another clip starts both from that clip. Equal keys on siblings make React reuse one of
// them: the title form of clip 1, draft and all, stayed open under clip 2.
test("the caption box keys ClipText and HookSwitch apart", async () => {
  const source = await page();
  const keys = [...source.matchAll(/<(ClipText|HookSwitch) key=\{([^}]+)\}/g)].map((match) => [match[1], match[2]]);
  assert.deepEqual(keys.map(([name]) => name), ["ClipText", "HookSwitch"]);
  assert.notEqual(keys[0][1], keys[1][1]);
  for (const [, key] of keys) assert.match(key, /clip\.index/);
});

test("on a desktop the clip viewer is as wide as its two columns need, not HeroUI's lg (32rem)", async () => {
  // Modal size "lg" caps the dialog at max-w-lg; the video column (up to 320 px) and the text
  // column then squeeze the title into a column of single letters.
  const viewer = await viewerStylesheet();
  assert.match(viewer, /\.dialog \{ width: min\(980px, 100%\); max-width: min\(980px, 100%\); \}/);
});
