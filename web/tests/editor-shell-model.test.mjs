// T2.6: presentation rules of the editor shell (plan §6.1 badge, Appendix C.1/C.6 copy, §3.7 checks)
// in web/components/editor/shell-model.mjs. Pure functions; no DOM.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fakeDoc, fakePlan } from "../components/editor/__dev__/fakes.mjs";
import {
  BADGE_HELP,
  LIVE_WAVES,
  MESSAGES,
  actionableChecks,
  badgeHelp,
  badgeView,
  checksView,
  contentEqualsSeed,
  editorPageMode,
  exportMatchesSeed,
  exportRevision,
  formatClock,
  formatSeconds,
  frameToMs,
  liveEntries,
  messageFor,
  noticesView,
  playerView,
  rejectionText,
  safeApiHref,
  saveStatusView,
  validEditorIds,
} from "../components/editor/shell-model.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FPS = [30000, 1001];
const LIVE = { mode: "live", current: { text: true, plate: true, audio: true, logo: true } };

// The Python messages (src/ai_clipper/edit_v2/errors.py `_MESSAGES`) are the single source of the
// Indonesian copy; the shell mirrors the ones it shows and must never drift.
function pythonMessages() {
  const source = readFileSync(path.join(repoRoot, "src", "ai_clipper", "edit_v2", "errors.py"), "utf8");
  const block = source.slice(source.indexOf("_MESSAGES = {"), source.indexOf("MESSAGES: Mapping"));
  const entries = {};
  const literal = /"(?:[^"\\]|\\.)*"/g;
  for (const match of block.matchAll(/"([a-z0-9_]+)":\s*(\((?:\s*"(?:[^"\\]|\\.)*")+\s*\)|"(?:[^"\\]|\\.)*")/g)) {
    entries[match[1]] = match[2].match(literal).map((part) => JSON.parse(part)).join("");
  }
  return entries;
}

test("every shell message equals the Python message of the same code", () => {
  const python = pythonMessages();
  assert.ok(Object.keys(python).length >= 50, "parsed the Python table");
  for (const [code, text] of Object.entries(MESSAGES)) {
    assert.equal(text, python[code], code);
  }
  for (const code of ["tight_cut", "laughter_cut", "hook_overflow", "glyph_unsupported", "no_face", "unsafe_zone",
    "loudness_clamped", "peak_reduced", "music_shorter_than_clip", "render_failed", "render_timeout", "render_stalled",
    "verification_failed", "cancelled", "auto_file_unavailable", "needs_prepare", "source_missing",
    "source_unreadable", "selection_unreadable", "transcript_missing", "analysis_incomplete", "not_v3", "transcript_changed",
    "legacy_engine", "revision_conflict", "schema_too_new"]) {
    assert.ok(MESSAGES[code], code);
  }
});

test("messages carry the detail after the colon, as errors.message() does, with Indonesian numbers", () => {
  // Numbers in the detail read the Indonesian way, as the Musik panel writes them.
  assert.equal(messageFor("peak_reduced:-3.80 dB"), `${MESSAGES.peak_reduced} (−3,8 dB)`);
  assert.equal(messageFor("peak_reduced:-2.20 dB"), `${MESSAGES.peak_reduced} (−2,2 dB)`);
  assert.equal(messageFor("loudness_clamped:-16.30 LUFS"), `${MESSAGES.loudness_clamped} (−16,3 LUFS)`);
  assert.equal(messageFor("peak_reduced:12 dB"), `${MESSAGES.peak_reduced} (12 dB)`);
  assert.equal(messageFor("glyph_unsupported:U+1F602"), `${MESSAGES.glyph_unsupported} (U+1F602)`);
  assert.equal(messageFor("tight_cut"), MESSAGES.tight_cut);
  assert.equal(messageFor("no_such_code"), "Terjadi kesalahan (no_such_code)");
  assert.equal(messageFor(null), "Terjadi kesalahan");
});

test("a rejected command explains itself in Indonesian", () => {
  assert.equal(rejectionText({ code: "duration_out_of_bounds" }), MESSAGES.duration_out_of_bounds);
  assert.equal(rejectionText({ code: "x", userMessage: "Durasi minimal 3 detik" }), "Durasi minimal 3 detik");
  assert.equal(rejectionText({ code: "not_ready", message: "command rejected: not_ready" }), "Perubahan ini tidak bisa diterapkan");
  assert.equal(rejectionText(null), "Perubahan ini tidak bisa diterapkan");
});

test("frames become source-accurate clock text with a decimal comma", () => {
  assert.equal(frameToMs(0, FPS), 0);
  assert.equal(frameToMs(30, FPS), 1001);
  assert.equal(frameToMs(1811, FPS), 60427);
  assert.equal(frameToMs(25, [25, 1]), 1000);
  assert.equal(formatClock(0), "00:00,0");
  assert.equal(formatClock(12_345), "00:12,3");
  assert.equal(formatClock(48_000), "00:48,0");
  assert.equal(formatClock(59_999), "00:59,9");
  assert.equal(formatClock(754_900), "12:34,9");
  assert.equal(formatClock(3_723_400), "1:02:03,4");
  assert.equal(formatSeconds(1_400), "1,4 dtk");
  assert.equal(formatSeconds(4_004), "4,0 dtk");
});

test("the save state follows Appendix C.1 and C.6", () => {
  assert.deepEqual(saveStatusView({ save: "saved", savedAtMs: 10_000 }, 13_200), { text: "Tersimpan · 3 dtk lalu", tone: "ok", retry: false });
  assert.equal(saveStatusView({ save: "saved", savedAtMs: 10_000 }, 10_500).text, "Tersimpan · baru saja");
  assert.equal(saveStatusView({ save: "saved", savedAtMs: 10_000 }, 10_000 + 125_000).text, "Tersimpan · 2 mnt lalu");
  assert.equal(saveStatusView({ save: "saved", savedAtMs: 0 }, 2 * 3_600_000 + 5).text, "Tersimpan · 2 jam lalu");
  assert.equal(saveStatusView({ save: "saved", savedAtMs: null }, 5).text, "Tersimpan");
  assert.deepEqual(saveStatusView({ save: "saving" }, 0), { text: "Menyimpan…", tone: "busy", retry: false });
  assert.deepEqual(saveStatusView({ save: "dirty" }, 0), { text: "Belum tersimpan", tone: "warn", retry: false });
  assert.deepEqual(saveStatusView({ save: "conflict" }, 0), { text: "Konflik", tone: "danger", retry: false });
  assert.deepEqual(saveStatusView({ save: "error" }, 0),
    { text: "Gagal menyimpan; perubahan aman di browser ini", tone: "danger", retry: true });
});

test("the stage badge says '● Sesuai hasil akhir' only when every layer is current (§6.1)", () => {
  const plan = fakePlan();
  assert.deepEqual(badgeView({ status: "ready", plan, storePending: [], player: LIVE }),
    { tone: "exact", text: "● Sesuai hasil akhir", detail: null });
  const textPending = badgeView({ status: "ready", plan, storePending: ["text"], player: LIVE });
  assert.equal(textPending.tone, "pending");
  assert.equal(textPending.text, "Memperbarui teks…");
  const audio = badgeView({ status: "ready", plan, storePending: [], player: { mode: "live", current: { ...LIVE.current, audio: false } } });
  assert.equal(audio.text, "Menyiapkan audio…");
  const cells = { ...plan, plate: { ...plan.plate, cells: [
    ...Array.from({ length: 7 }, (_, k) => ({ k, state: "ready", url: `/c${k}` })),
    ...Array.from({ length: 23 }, (_, k) => ({ k: k + 7, state: "queued" })),
  ] } };
  const plate = badgeView({ status: "ready", plan: cells, storePending: ["plate"], player: { mode: "live", current: { ...LIVE.current, plate: false } } });
  assert.equal(plate.text, "Menyiapkan video (7/30)…");
  const several = badgeView({ status: "ready", plan, storePending: ["text", "audio"], player: LIVE });
  assert.equal(several.text, "Memperbarui teks… · Menyiapkan audio…");
  assert.ok(!several.text.includes("Sesuai"));
  const logoPlan = { ...plan, logo: { box: { x: 1, y: 1, w: 10, h: 10 }, opacityPm: 850, url: "/l.png" } };
  assert.equal(badgeView({ status: "ready", plan: logoPlan, storePending: [], player: { mode: "live", current: { ...LIVE.current, logo: false } } }).text,
    "Memperbarui logo…");
  assert.equal(badgeView({ status: "ready", plan, storePending: [], player: { mode: "live", current: { ...LIVE.current, logo: false } } }).text,
    "● Sesuai hasil akhir", "no logo in the plan: the logo layer is trivially current");
});

test("a playhead frame the player gave up on is named, not 'Menyiapkan frame…' forever", () => {
  const plan = fakePlan();
  const paused = { ...LIVE, playing: false, exact: false };
  assert.deepEqual(badgeView({ status: "ready", plan, storePending: [], player: paused }),
    { tone: "pending", text: "Menyiapkan frame…", detail: null });
  const failed = badgeView({ status: "ready", plan, storePending: [], player: { ...paused, plateError: true } });
  assert.deepEqual(failed, { tone: "failed", text: "Frame gagal dimuat", detail: "Putar atau geser playhead untuk mencoba lagi" });
  assert.match(badgeHelp(failed), /Frame akhir/);
  assert.notEqual(badgeHelp(failed), BADGE_HELP);
  // A layer still pending is named first; a drawn frame is exact again.
  assert.equal(badgeView({ status: "ready", plan, storePending: ["text"], player: { ...paused, plateError: true } }).text, "Memperbarui teks…");
  assert.equal(badgeView({ status: "ready", plan, storePending: [], player: { ...LIVE, playing: false, exact: true, plateError: false } }).tone, "exact");
});

test("the shell keeps the player state it shows, including a plate the player gave up on", () => {
  const live = { mode: "live", frame: 0, playing: false, exact: false, error: null, current: { ...LIVE.current } };
  const first = playerView(null, live);
  assert.deepEqual(first, { mode: "live", current: LIVE.current, playing: false, exact: false, plateError: false });
  assert.equal(playerView(first, { ...live, frame: 3 }), first, "an unchanged view keeps its identity (no re-render)");
  const failed = playerView(first, { ...live, error: { layer: "plate", message: "plate_cell_failed:47:x" } });
  assert.notEqual(failed, first);
  assert.equal(failed.plateError, true);
  assert.equal(playerView(first, { ...live, error: { layer: "audio", message: "audio_fetch_failed:500" } }).plateError, false);
  assert.equal(playerView(failed, { mode: "live", current: LIVE.current }).playing, false, "a partial state keeps playing");
});

test("revision 0 on the auto render, truth frames, unsupported browsers and loading", () => {
  const plan = { ...fakePlan(), rev0: { planSha256: "a".repeat(64), autoRenderUrl: "/api/jobs/x/files/output/clip-01.mp4", exact: true } };
  assert.deepEqual(badgeView({ status: "ready", plan, storePending: [], player: { mode: "auto_render", current: {} } }),
    { tone: "exact", text: "● Sesuai hasil akhir", detail: "Memutar klip otomatis (identik)" });
  const inexact = { ...plan, rev0: { ...plan.rev0, exact: false } };
  assert.notEqual(badgeView({ status: "ready", plan: inexact, storePending: [], player: { mode: "auto_render", current: {} } }).tone, "exact");
  assert.deepEqual(badgeView({ status: "ready", plan, storePending: ["text"], player: { mode: "truth", current: {} } }),
    { tone: "truth", text: "● Frame akhir", detail: "Piksel persis hasil render akhir" });
  assert.deepEqual(badgeView({ status: "ready", plan, storePending: [], player: { mode: "unsupported", current: {} } }),
    { tone: "unsupported", text: "Pratinjau langsung butuh Chrome/Edge desktop. Anda tetap bisa mengedit dan mengekspor.", detail: null });
  assert.equal(badgeView({ status: "loading", plan: null, storePending: [], player: null }).text, "Membuka klip…");
  assert.equal(badgeView({ status: "ready", plan, storePending: [], player: null }).text, "Menyiapkan pratinjau…");
});

test("the help popover text is the §6.1 statement, verbatim", () => {
  assert.equal(BADGE_HELP, "Frame, teks, logo dan audio sama dengan hasil akhir. File MP4 akhir dikompresi (H.264, warna 4:2:0), "
    + "jadi tepi teks berwarna sedikit lebih lembut. Tekan 'Frame akhir' untuk melihat piksel persisnya.");
});

test("checks merge store and plan warnings, dedupe, sort by frame and carry jump targets", () => {
  const checks = checksView({
    warnings: [{ code: "tight_cut", ref: "rm_01", f: 402 }, { code: "peak_reduced:-3.80 dB", path: "/audio" }],
    plan: { fps: FPS, warnings: [{ code: "tight_cut", ref: "rm_01", f: 402 }, { code: "hook_overflow", ref: "it_hook", f: 0 }], errors: [] },
  });
  assert.deepEqual(checks.map((check) => [check.code, check.f, check.timeText]), [
    ["hook_overflow", 0, "00:00,0"],
    ["tight_cut", 402, "00:13,4"],
    ["peak_reduced:-3.80 dB", null, null],
  ]);
  assert.equal(checks[2].message, `${MESSAGES.peak_reduced} (−3,8 dB)`);
  assert.equal(checks[0].severity, "warning");
  assert.equal(new Set(checks.map((check) => check.key)).size, checks.length);
  const blocking = checksView({ warnings: [], plan: { fps: FPS, warnings: [], errors: [{ code: "cold_open_invalid", path: "/main/segments/0" }] } });
  assert.equal(blocking[0].severity, "error");
  assert.equal(blocking[0].message, MESSAGES.cold_open_invalid);
  assert.deepEqual(checksView({ warnings: undefined, plan: null }), []);
});

test("a TikTok-zone check names the caption, the hook or the logo it is about", () => {
  const checks = checksView({ warnings: [], plan: { fps: FPS, errors: [], warnings: [
    { code: "unsafe_zone", path: "/captions/overrides/y_e5", f: 3 },
    { code: "unsafe_zone", path: "/tracks/0/items/0/transform/y_e5", ref: "it_hook", f: 0 },
    { code: "unsafe_zone", path: "/tracks/1/items/0/transform", ref: "it_logo" },
    { code: "unsafe_zone", path: "/somewhere/else" },
  ] } });
  assert.deepEqual(checks.map((check) => check.message), [
    "Hook masuk ke area tombol TikTok",
    "Caption masuk ke area tombol TikTok",
    "Logo masuk ke area tombol TikTok",
    MESSAGES.unsafe_zone,
  ]);
});

// Owner decision (W4, K5): the caption keeps the auto clip's spot, which reaches into the TikTok
// zone. That spot is a note (informative, no tick before export); a caption the user moved into the
// zone stays a check.
test("the caption at its auto-clip spot in the TikTok zone is a note, not a check (K5)", () => {
  const seed = fakeDoc();
  const zone = { code: "unsafe_zone", path: "/captions/overrides/y_e5", f: 3 };
  const plan = { fps: FPS, errors: [], warnings: [zone, { code: "tight_cut", ref: "rm_01", f: 9 }] };
  const atSeed = checksView({ warnings: [], plan, doc: structuredClone(seed), seed });
  const note = atSeed.find((check) => check.code === "unsafe_zone");
  assert.equal(note.severity, "info");
  assert.equal(note.message, "Caption di posisi bawaan, dekat tombol TikTok. Kalau tertutup, geser ke atas di tab Teks.");
  assert.equal(note.timeText, "00:00,1");
  assert.equal(atSeed.at(-1), note, "notes come after the checks");
  assert.deepEqual(actionableChecks(atSeed).map((check) => check.code), ["tight_cut"]);

  const moved = structuredClone(seed);
  moved.captions.overrides.y_e5 = 90000;
  const check = checksView({ warnings: [], plan, doc: moved, seed }).find((item) => item.code === "unsafe_zone");
  assert.equal(check.severity, "warning");
  assert.equal(check.message, "Caption masuk ke area tombol TikTok");
  assert.equal(actionableChecks(checksView({ warnings: [], plan, doc: moved, seed })).length, 2);

  // The hook and the logo are always placed by the user: they stay checks at any spot.
  const others = checksView({ warnings: [], doc: structuredClone(seed), seed, plan: { fps: FPS, errors: [], warnings: [
    { code: "unsafe_zone", path: "/tracks/0/items/0/transform/y_e5", ref: "it_hook", f: 0 },
    { code: "unsafe_zone", path: "/tracks/1/items/0/transform", ref: "it_logo" },
  ] } });
  assert.deepEqual(others.map((item) => item.severity), ["warning", "warning"]);
});

test("content identity ignores revision, parent and audit (R10)", () => {
  const seed = fakeDoc();
  const saved = { ...structuredClone(seed), revision: 7, parent_sha256: "b".repeat(64),
    audit: { ...seed.audit, updated_at_ms: seed.audit.updated_at_ms + 99, last_command: "ResetToSeed" } };
  assert.equal(contentEqualsSeed(saved, seed), true);
  const reordered = Object.fromEntries(Object.entries(saved).reverse());
  assert.equal(contentEqualsSeed(reordered, seed), true);
  const edited = structuredClone(saved);
  edited.captions.pack = { id: "bold", v: 1 };
  assert.equal(contentEqualsSeed(edited, seed), false);
  assert.equal(contentEqualsSeed(saved, null), false);
  const plan = fakePlan(seed);
  assert.equal(exportMatchesSeed({ plan: { ...plan, rev0: { ...plan.rev0, planSha256: plan.planSha256 } }, doc: edited, seed: null }), true);
  assert.equal(exportMatchesSeed({ plan: { ...plan, rev0: { ...plan.rev0, planSha256: "c".repeat(64) } }, doc: saved, seed }), true);
  assert.equal(exportMatchesSeed({ plan: { ...plan, rev0: { ...plan.rev0, planSha256: "c".repeat(64) } }, doc: edited, seed }), false);
});

test("notices: legacy engine, other tab, unsupported browser", () => {
  const doc = fakeDoc();
  assert.deepEqual(noticesView({ doc, playerMode: "live", otherTab: false }), []);
  const legacy = structuredClone(doc);
  legacy.base.engine.compiler = "legacy";
  assert.deepEqual(noticesView({ doc: legacy, playerMode: "live", otherTab: true }).map((notice) => notice.code),
    ["legacy_engine", "other_tab"]);
  assert.equal(noticesView({ doc: legacy, playerMode: "live", otherTab: false })[0].text,
    "Klip otomatis ini dibuat sebelum editor dibuka; setelah klip diubah, tampilan teks hasil ekspor bisa sedikit berbeda");
  assert.equal(noticesView({ doc, playerMode: "live", otherTab: true })[0].text, "Klip ini terbuka di tab lain");
  assert.deepEqual(noticesView({ doc, playerMode: "unsupported", otherTab: false }).map((notice) => notice.code), ["unsupported_browser"]);
});

test("the editor page is behind POTONGIN_EDITOR_V3 and fakes only with the dev flag", () => {
  assert.equal(editorPageMode({}), "off");
  assert.equal(editorPageMode({ POTONGIN_EDITOR_V3: "off" }), "off");
  assert.equal(editorPageMode({ POTONGIN_EDITOR_FAKES: "1" }), "off", "fakes never open the page on their own");
  assert.equal(editorPageMode({ POTONGIN_EDITOR_V3: "on" }), "real");
  assert.equal(editorPageMode({ POTONGIN_EDITOR_V3: "on", POTONGIN_EDITOR_FAKES: "1" }), "fake");
  assert.equal(editorPageMode({ POTONGIN_EDITOR_V3: "true" }), "off", "only the documented value turns it on");
});

test("links and media from DTOs are same-origin API paths only", () => {
  assert.equal(safeApiHref("/api/jobs/j/files/output/edits/c/a.mp4"), "/api/jobs/j/files/output/edits/c/a.mp4");
  for (const hostile of ["javascript:alert(1)", "https://evil.example/a.mp4", "//evil.example/a.mp4", "/api\\..\\x",
    "/projects/x", "/api/jobs/j/\u0000x", null, 42]) {
    assert.equal(safeApiHref(hostile), null, String(hostile));
  }
});

test("page ids are validated before anything runs", () => {
  assert.equal(validEditorIds("8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "clip_9b2e41c07d3a5f18e6c2a0b4"), true);
  assert.equal(validEditorIds("8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "clip_9B2E41C07D3A5F18E6C2A0B4"), false);
  assert.equal(validEditorIds("../etc", "clip_9b2e41c07d3a5f18e6c2a0b4"), false);
  assert.equal(validEditorIds("8f0c2a1e-5b7d-4c3a-9e21-6d4f0b8a7c55", "clip_9b2e41c07d3a5f18e6c2a0b"), false);
  assert.equal(validEditorIds(undefined, undefined), false);
});

test("the export dialog names the saved revision, not the loaded document's (W2 verifier)", () => {
  // the real store keeps the loaded document's revision in `doc` and the saved one in `revision`
  assert.equal(exportRevision({ revision: 3, doc: { revision: 0 } }), 3);
  assert.equal(exportRevision({ revision: null, doc: { revision: 2 } }), 2);
  assert.equal(exportRevision({ doc: null }), 0);
  assert.equal(exportRevision(null), 0);
});

test("the badge help explains the badge it belongs to (§6.1, W2 verifier)", () => {
  assert.equal(badgeHelp({ tone: "exact" }), BADGE_HELP);
  const pending = badgeHelp({ tone: "pending" });
  assert.notEqual(pending, BADGE_HELP);
  assert.match(pending, /belum/);
  assert.doesNotMatch(pending, /^Frame, teks, logo dan audio sama dengan hasil akhir/);
  const legacy = badgeHelp({ tone: "legacy" });
  assert.match(legacy, /dibuat sebelum editor dibuka/);
  assert.doesNotMatch(legacy, /mesin (?:lama|baru)/i);
  assert.match(legacy, /file klip otomatis/);
  assert.doesNotMatch(legacy, /^Frame, teks, logo dan audio sama dengan hasil akhir/);
  assert.match(badgeHelp({ tone: "truth" }), /Frame akhir/);
  for (const tone of ["loading", "unsupported"]) {
    assert.equal(typeof badgeHelp({ tone }), "string");
    assert.notEqual(badgeHelp({ tone }), BADGE_HELP);
  }
  assert.notEqual(badgeHelp(null), BADGE_HELP);
});

test("panels and lanes of a wave that has not landed are hidden in the app, shown on the fakes", () => {
  const entries = [{ id: "a", wave: "W3" }, { id: "b", wave: "W4" }, { id: "c", wave: "W2" }];
  assert.deepEqual([...LIVE_WAVES], ["W1", "W2", "W3"]);
  assert.deepEqual(liveEntries(entries, "real").map((entry) => entry.id), ["a", "c"]);
  assert.deepEqual(liveEntries(entries, "fake").map((entry) => entry.id), ["a", "b", "c"]);
  assert.deepEqual(liveEntries(entries, "real", ["W3", "W4"]).map((entry) => entry.id), ["a", "b"]);
});

test("W3 has landed: every registered panel, lane and gizmo shows in the app", async () => {
  const [{ PANELS }, { LANES }, { GIZMOS }] = await Promise.all([
    import("../components/editor/panels/index.mjs"),
    import("../components/editor/timeline/lanes.mjs"),
    import("../components/editor/gizmos/index.mjs"),
  ]);
  assert.deepEqual(liveEntries(PANELS, "real").map((entry) => entry.id), ["transcript", "text", "coldopen", "layout", "logo", "music"]);
  assert.deepEqual(liveEntries(LANES, "real").map((entry) => entry.id), ["video", "captions", "hook", "audio", "markers", "music"]);
  assert.deepEqual(liveEntries(GIZMOS, "real").map((entry) => entry.id), ["logo"]);
});
