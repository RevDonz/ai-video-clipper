// Mode Cepat's cards and the Lengkap panels on one model (docs/plans/2026-10-02-editor-mode-cepat.md
// §1.3, §1.4, §3, AC5, AC7): the caption presets in both directions, every card summary, the
// commands both views build for the same choice (and their merge keys), and the caption notes and
// hook hint. The last block reads the card and panel sources to show that both views call the same
// model function for each shared control.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FAKE_JOB_ID, createFakeUploadClient, fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  CAPTION_PACKS,
  CAPTION_POSITIONS,
  CAPTION_SIZES,
  CAPTION_NOTES,
  HOOK_NEAR_BAND_E5,
  captionCommand,
  captionPackCommand,
  captionZoneNote,
  captionsEnabledCommand,
  highlightNote,
  hookNearNote,
  presetId,
} from "../components/editor/panels/caption-model.mjs";
import { transitionCommands } from "../components/editor/panels/coldopen-transition.mjs";
import {
  HOOK_FIT_TEXT,
  HOOK_MAX,
  cleanHookText,
  hookEnableText,
  hookEnabledCommand,
  hookFit,
  hookPoints,
  hookTextCommand,
} from "../components/editor/panels/hook-model.mjs";
import { LAYOUT_OPTIONS, layoutCommand } from "../components/editor/panels/layout-model.mjs";
import { DUCK_PRESET_LIST, musicCommands } from "../components/editor/panels/music-model.mjs";
import {
  CARD_LAYOUTS,
  captionSummary,
  cardSummary,
  coldOpenSummary,
  extrasSummary,
  hookSummary,
  layoutSummary,
} from "../components/editor/quick/quick-model.mjs";
import { applyCommand as suggestionCommand } from "../components/editor/suggestions/model.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";

const editorDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "components", "editor");
const source = (file) => readFileSync(path.join(editorDir, file), "utf8");

const CTX = createContext({ words: fakeWords(), seed: fakeDoc() });
const run = (doc, type, args) => applyCommand(doc, type, args, CTX).doc;
const withOverrides = (patch, doc = fakeDoc()) => ({ ...doc, captions: { ...doc.captions, overrides: { ...doc.captions.overrides, ...patch } } });
const withHookY = (y, doc = fakeDoc()) => ({
  ...doc,
  tracks: doc.tracks.map((track) => (track.kind === "hook"
    ? { ...track, items: track.items.map((item) => ({ ...item, transform: { ...item.transform, y_e5: y } })) } : track)),
});
const withoutHook = (doc = fakeDoc()) => run(doc, "SetHookEnabled", { on: false });
const COLD = () => run(fakeDoc(), "SetColdOpen", { firstWord: "w048127", lastWord: "w048132" });
const LOGO_HEX = "5c1f".padEnd(64, "a");
const withLogo = (doc = fakeDoc()) => run(doc, "SetLogo", {
  asset: `sha256:${LOGO_HEX}`,
  meta: { sha256: LOGO_HEX, kind: "logo", mime: "image/png", w: 512, h: 512, durationMs: null, lufsC: null, peaksUrl: null },
});
async function withMusic(doc = fakeDoc()) {
  const dto = await createFakeUploadClient().uploadAsset(FAKE_JOB_ID, { name: "lagu.m4a", size: 4096, type: "audio/mp4" }, "music");
  return musicCommands.add(dto).reduce((current, command) => run(current, command.type, command.args), doc);
}

// --- presets ---------------------------------------------------------------------------------------

test("the caption presets are the spec's: sizes 850/1000/1200, positions 38/60/83 % (Bawah is the seed spot)", () => {
  assert.deepEqual(CAPTION_SIZES.map((entry) => [entry.id, entry.label, entry.value]),
    [["kecil", "Kecil", 850], ["sedang", "Sedang", 1000], ["besar", "Besar", 1200]]);
  assert.deepEqual(CAPTION_POSITIONS.map((entry) => [entry.id, entry.label, entry.value]),
    [["atas", "Atas", 38000], ["tengah", "Tengah", 60000], ["bawah", "Bawah", 83000]]);
  const seed = fakeDoc().captions.overrides;
  assert.equal(presetId(CAPTION_POSITIONS, seed.y_e5), "bawah");
  assert.equal(presetId(CAPTION_SIZES, seed.size_pm), "sedang");
  assert.ok(Object.isFrozen(CAPTION_SIZES) && Object.isFrozen(CAPTION_POSITIONS));
});

test("a preset value presses its pill; a value off the presets presses none", () => {
  for (const option of [...CAPTION_SIZES, ...CAPTION_POSITIONS]) {
    const list = CAPTION_SIZES.includes(option) ? CAPTION_SIZES : CAPTION_POSITIONS;
    assert.equal(presetId(list, option.value), option.id);
  }
  for (const value of [849, 920, 1150, 1400]) assert.equal(presetId(CAPTION_SIZES, value), null, String(value));
  for (const value of [37500, 72000, 83500, 92000]) assert.equal(presetId(CAPTION_POSITIONS, value), null, String(value));
  assert.equal(presetId(CAPTION_SIZES, undefined), null);
  assert.equal(presetId(CAPTION_SIZES, "1000"), null, "a string is not the stored integer");
});

test("the four packs keep the Teks panel's names and notes", () => {
  assert.deepEqual(CAPTION_PACKS.map((pack) => [pack.id, pack.name, pack.note]), [
    ["classic", "Klasik", "Putih bergaris hitam"],
    ["karaoke", "Karaoke", "Kata terucap menyala"],
    ["bold", "Bold", "Tebal, kata aktif berwarna"],
    ["box", "Box", "Teks di kotak gelap"],
  ]);
});

// --- summaries -----------------------------------------------------------------------------------

test("Caption sums up pack, size and position; off-preset values show their percent; off says Mati", () => {
  assert.equal(captionSummary(fakeDoc()), "Karaoke · Sedang · Bawah");
  assert.equal(captionSummary(withOverrides({ size_pm: 1200, y_e5: 38000 })), "Karaoke · Besar · Atas");
  assert.equal(captionSummary(run(fakeDoc(), "SetCaptionPack", { id: "box" })), "Box · Sedang · Bawah");
  assert.equal(captionSummary(withOverrides({ size_pm: 920 })), "Karaoke · 92% · Bawah");
  assert.equal(captionSummary(withOverrides({ y_e5: 72000 })), "Karaoke · Sedang · posisi 72%");
  assert.equal(captionSummary(withOverrides({ size_pm: 1350, y_e5: 72500 })), "Karaoke · 135% · posisi 73%");
  assert.equal(captionSummary(run(fakeDoc(), "SetCaptionsEnabled", { on: false })), "Mati");
  assert.equal(captionSummary(null), "");
});

test("Hook sums up its text, or Mati", () => {
  assert.equal(hookSummary(fakeDoc()), "Kenapa sutradara ditahan di film sendiri?");
  assert.equal(hookSummary(run(fakeDoc(), "SetHookText", { text: "Dia ditahan security", origin: "user" })), "Dia ditahan security");
  assert.equal(hookSummary(withoutHook()), "Mati");
  assert.equal(hookSummary(null), "");
});

test("Cold open sums up the transition, + whoosh when on, or Mati without a cold open", () => {
  assert.equal(coldOpenSummary(fakeDoc()), "Mati");
  const cold = COLD();
  assert.equal(coldOpenSummary(cold), "Kilat putih + whoosh");
  const quiet = run(cold, "SetJoinSfx", { on: false });
  assert.equal(coldOpenSummary(quiet), "Kilat putih");
  assert.equal(coldOpenSummary(run(quiet, "SetJoinStyle", { style: "dip_black" })), "Gelap sebentar");
  assert.equal(coldOpenSummary(run(cold, "SetJoinStyle", { style: "cut" })), "Potong langsung + whoosh");
  assert.equal(coldOpenSummary(null), "");
});

test("Tata letak sums up the layout, and says so while the face analysis runs", () => {
  assert.equal(layoutSummary(fakeDoc()), "Latar blur");
  assert.equal(layoutSummary(run(fakeDoc(), "SetLayout", { mode: "fill_center" })), "Potong tengah");
  assert.equal(layoutSummary(run(fakeDoc(), "SetLayout", { mode: "camera" })), "Ikuti wajah");
  for (const phase of ["starting", "running"]) {
    assert.equal(layoutSummary(fakeDoc(), { phase }), "Latar blur · menganalisis…", phase);
  }
  for (const phase of ["idle", "failed"]) assert.equal(layoutSummary(fakeDoc(), { phase }), "Latar blur", phase);
  assert.equal(layoutSummary(null), "");
});

test("Logo & Musik sums up what the clip has", async () => {
  assert.equal(extrasSummary(fakeDoc()), "Belum ada");
  assert.equal(extrasSummary(withLogo()), "Logo");
  assert.equal(extrasSummary(await withMusic()), "Musik");
  assert.equal(extrasSummary(await withMusic(withLogo())), "Logo dan musik");
  assert.equal(extrasSummary(null), "");
});

test("cardSummary answers for every card id, Teks caption through linesSummary", () => {
  const doc = fakeDoc();
  const state = { status: "ready", doc, seed: fakeDoc(), plan: fakePlan(doc), words: fakeWords() };
  // The fakes caption like the engine (spec §2.6): a break after "sendiri?" makes 4 lines.
  assert.deepEqual(["hook", "caption", "lines", "coldopen", "layout", "extras"].map((id) => cardSummary(id, { state })), [
    "Kenapa sutradara ditahan di film sendiri?", "Karaoke · Sedang · Bawah", "4 baris", "Mati", "Latar blur", "Belum ada",
  ]);
  assert.equal(cardSummary("layout", { state, analysis: { phase: "running" } }), "Latar blur · menganalisis…");
  assert.equal(cardSummary("lines", { state: { ...state, plan: null } }), "Menyiapkan…");
  assert.equal(cardSummary("nope", { state }), "");
  assert.equal(cardSummary("caption", { state: null }), "");
});

test("the Tata letak card lists the mockup's order: Latar blur, Potong tengah, Ikuti wajah", () => {
  assert.deepEqual(CARD_LAYOUTS.map((option) => [option.id, option.name]),
    [["fit_blur", "Latar blur"], ["fill_center", "Potong tengah"], ["camera", "Ikuti wajah"]]);
  for (const option of CARD_LAYOUTS) assert.ok(LAYOUT_OPTIONS.includes(option), "the panel's own option objects");
});

// --- commands: one model function per control, the same { type, args } in both views ---------------

test("captionCommand: a pick has no merge key, a slider drag merges per key", () => {
  assert.deepEqual(captionCommand("size_pm", 1200), { type: "SetCaptionOverride", args: { key: "size_pm", value: 1200 }, mergeKey: null });
  assert.deepEqual(captionCommand("y_e5", 38000, { drag: false }), { type: "SetCaptionOverride", args: { key: "y_e5", value: 38000 }, mergeKey: null });
  assert.deepEqual(captionCommand("y_e5", 61500, { drag: true }), { type: "SetCaptionOverride", args: { key: "y_e5", value: 61500 }, mergeKey: "cap:y_e5" });
  assert.deepEqual(captionCommand("size_pm", 1150, { drag: true }).mergeKey, "cap:size_pm");
  assert.deepEqual(captionCommand("highlight", "#3DF5A6"), { type: "SetCaptionOverride", args: { key: "highlight", value: "#3DF5A6" }, mergeKey: null });
  // The card's pill and the panel's slider at the same value build the same command but the key.
  const pick = captionCommand("y_e5", 60000);
  const drag = captionCommand("y_e5", 60000, { drag: true });
  assert.deepEqual([pick.type, pick.args], [drag.type, drag.args]);
  assert.deepEqual(captionPackCommand("bold"), { type: "SetCaptionPack", args: { id: "bold" }, mergeKey: null });
  assert.deepEqual(captionsEnabledCommand(false), { type: "SetCaptionsEnabled", args: { on: false }, mergeKey: null });
  // Each preset is a value the real command accepts.
  for (const option of CAPTION_SIZES) run(fakeDoc(), "SetCaptionOverride", captionCommand("size_pm", option.value).args);
  for (const option of CAPTION_POSITIONS) run(fakeDoc(), "SetCaptionOverride", captionCommand("y_e5", option.value).args);
});

test("hook text: cleaned, at most 90 code points, merged under hook:text; nothing when unchanged or empty", () => {
  const doc = fakeDoc();
  assert.equal(HOOK_MAX, 90);
  assert.equal(cleanHookText("  Dia\nditahan\u0007 "), "Dia ditahan");
  assert.equal(hookPoints("😂ab"), 3);
  assert.deepEqual(hookTextCommand(doc, "Dia ditahan security "),
    { type: "SetHookText", args: { text: "Dia ditahan security", origin: "user" }, mergeKey: "hook:text" });
  assert.equal(hookTextCommand(doc, "   "), null);
  assert.equal(hookTextCommand(doc, "Kenapa sutradara ditahan di film sendiri?"), null, "the same text");
  assert.equal(hookTextCommand(doc, "a".repeat(91)), null);
  assert.equal(hookTextCommand(doc, "a".repeat(90)).args.text.length, 90);
  assert.equal(hookTextCommand(withoutHook(), "Teks baru"), null, "no hook to change");
  assert.deepEqual(hookEnabledCommand(true, "Teks"), { type: "SetHookEnabled", args: { on: true, text: "Teks" }, mergeKey: null });
  assert.deepEqual(hookEnabledCommand(false), { type: "SetHookEnabled", args: { on: false }, mergeKey: null });
  assert.equal(hookEnableText("", fakeDoc()), "Kenapa sutradara ditahan di film sendiri?");
  assert.equal(hookEnableText("Draf", fakeDoc()), "Draf");
});

test("the hook fit badge: Memeriksa… while the text plans, Akan terpotong on overflow, else Muat", () => {
  const doc = fakeDoc();
  const plan = fakePlan(doc);
  assert.equal(hookFit({ doc, plan, pending: [] }), "fits");
  assert.equal(hookFit({ doc, plan, pending: ["text"] }), "checking");
  assert.equal(hookFit({ doc, plan: { ...plan, hook: { ...plan.hook, overflow: true } }, pending: [] }), "overflow");
  assert.equal(hookFit({ doc, plan: { ...plan, warnings: [{ code: "hook_overflow" }] }, pending: [] }), "overflow");
  assert.equal(hookFit({ doc: withoutHook(), plan, pending: [] }), null);
  assert.deepEqual(HOOK_FIT_TEXT, { checking: "Memeriksa…", overflow: "Akan terpotong", fits: "Muat" });
});

test("a suggestion, a layout, a transition and a duck strength each come from one model function", () => {
  const doc = fakeDoc();
  assert.deepEqual(suggestionCommand(doc, { id: "hk_2", text: "Sutradara ditahan" }),
    { type: "SetHookText", args: { text: "Sutradara ditahan", origin: "suggestion:hk_2" } });
  assert.deepEqual(suggestionCommand(withoutHook(), { id: "hk_2", text: "Sutradara ditahan" }),
    { type: "SetHookEnabled", args: { on: true, text: "Sutradara ditahan", origin: "suggestion:hk_2" } });
  for (const option of LAYOUT_OPTIONS) {
    assert.deepEqual(layoutCommand(option.id), { type: "SetLayout", args: { mode: option.id }, mergeKey: null });
  }
  assert.throws(() => layoutCommand("nope"), TypeError);
  assert.deepEqual(transitionCommands.style("dip_black"), { type: "SetJoinStyle", args: { style: "dip_black" }, mergeKey: null });
  assert.deepEqual(transitionCommands.sfx(false), { type: "SetJoinSfx", args: { on: false }, mergeKey: null });
  assert.deepEqual(DUCK_PRESET_LIST.map((preset) => musicCommands.duckPreset(preset.id)), [
    [{ type: "SetDuck", args: { preset: "halus" }, mergeKey: "music:duck" }],
    [{ type: "SetDuck", args: { preset: "sedang" }, mergeKey: "music:duck" }],
    [{ type: "SetDuck", args: { preset: "kuat" }, mergeKey: "music:duck" }],
  ]);
});

test("both views call the same model function for every shared control", () => {
  const card = (name) => source(`quick/${name}.jsx`);
  const pairs = [
    ["captionCommand(", card("CaptionCard"), source("panels/TextPanel.jsx")],
    ["captionPackCommand(", card("CaptionCard"), source("panels/TextPanel.jsx")],
    ["captionsEnabledCommand(", card("CaptionCard"), source("panels/TextPanel.jsx")],
    ["highlightNote(", card("CaptionCard"), source("panels/TextPanel.jsx")],
    ["captionZoneNote(", card("CaptionCard"), source("panels/TextPanel.jsx")],
    ["hookNearNote(", card("CaptionCard"), source("panels/TextPanel.jsx")],
    ["hookTextCommand(", card("HookCard"), source("panels/TextPanel.jsx")],
    ["hookEnabledCommand(", card("HookCard"), source("panels/TextPanel.jsx")],
    ["hookFit(", card("HookCard"), source("panels/TextPanel.jsx")],
    ["useHookSuggestions(", source("suggestions/CompactSuggestions.jsx"), source("suggestions/index.jsx")],
    ["<TransitionSection", card("ColdOpenCard"), source("panels/ColdOpenPanel.jsx")],
    ["<ColdOpenSuggestions", card("ColdOpenCard"), source("panels/ColdOpenPanel.jsx")],
    ["layoutAnalysisFor(", card("LayoutCard"), source("panels/LayoutPanel.jsx")],
    ["layoutCommand(", card("LayoutCard"), source("panels/LayoutPanel.jsx")],
    ["musicUploadFor(", card("ExtrasCard"), source("panels/MusicPanel.jsx")],
    ["musicCommands.duckPreset(", card("ExtrasCard"), source("panels/MusicPanel.jsx")],
    ["musicNoticeRead(", card("ExtrasCard"), source("panels/MusicPanel.jsx")],
    ["logoUploads.start(", card("ExtrasCard"), source("panels/LogoPanel.jsx")],
    ["logoUploadCommand(", card("ExtrasCard"), source("panels/LogoPanel.jsx")],
  ];
  for (const [call, quick, panel] of pairs) {
    assert.ok(quick.includes(call), `the card calls ${call}`);
    assert.ok(panel.includes(call), `the panel calls ${call}`);
  }
  // Applying a suggestion goes through the suggestions model in the shared hook, not per view.
  assert.ok(source("suggestions/use-hook-suggestions.js").includes("applyCommand(doc, suggestion)"));
});

// --- notes and the hook hint (§1.4, §3) --------------------------------------------------------------

test("highlightNote: Karaoke and Bold light the spoken word; the other packs say the colour is unused", () => {
  assert.equal(highlightNote("karaoke"), "Kata yang sedang diucapkan.");
  assert.equal(highlightNote("bold"), "Kata yang sedang diucapkan.");
  assert.equal(highlightNote("classic"), "Dipakai oleh Karaoke dan Bold; tidak tampak di gaya ini.");
  assert.equal(highlightNote("box"), "Dipakai oleh Karaoke dan Bold; tidak tampak di gaya ini.");
  assert.equal(CAPTION_NOTES.highlightOn, highlightNote("karaoke"));
});

test("captionZoneNote: none without the caption zone warning; a calm note at the seed spot; a warning elsewhere", () => {
  const seed = fakeDoc();
  const zone = { code: "unsafe_zone", path: "/captions/overrides/y_e5", f: 3 };
  const plan = (warnings) => ({ ...fakePlan(seed), warnings });
  assert.equal(captionZoneNote(seed, seed, plan([])), null);
  assert.equal(captionZoneNote(seed, seed, null), null);
  assert.deepEqual(captionZoneNote(seed, seed, plan([zone])),
    { tone: "note", text: "Posisi bawaan, dekat tombol TikTok. Kalau tertutup, geser caption ke atas." });
  assert.deepEqual(captionZoneNote(withOverrides({ y_e5: 90000 }), seed, plan([zone])),
    { tone: "warning", text: "Caption masuk area tombol TikTok/Reels; geser ke atas bila tertutup." });
  // A warning without a path counts for the caption only when it names no item (the hook's carries its id).
  assert.equal(captionZoneNote(seed, seed, plan([{ code: "unsafe_zone", ref: "it_hook" }])), null);
  assert.equal(captionZoneNote(seed, seed, plan([{ code: "unsafe_zone" }])).tone, "note");
  assert.equal(captionZoneNote(seed, seed, plan([{ code: "unsafe_zone", path: "/tracks/0/items/0/transform", ref: "it_hook" }])), null);
});

test("hookNearNote: with the seed hook it shows at Atas and leaves at Tengah, Bawah and with the hook or captions off", () => {
  const hint = "Caption dekat teks hook. Kalau bertumpuk di pratinjau, turunkan caption.";
  const at = (y, doc = fakeDoc()) => hookNearNote(withOverrides({ y_e5: y }, doc));
  assert.equal(HOOK_NEAR_BAND_E5, 35000);
  assert.equal(at(38000), hint, "Atas");
  assert.equal(at(60000), null, "Tengah");
  assert.equal(at(83000), null, "Bawah");
  assert.equal(at(38000, withoutHook()), null, "hook off");
  assert.equal(at(38000, run(fakeDoc(), "SetCaptionsEnabled", { on: false })), null, "captions off");
  // The band: bottom < top + 35000. The seed hook's top is 13000, so 48000 is the edge.
  assert.equal(at(47999), hint);
  assert.equal(at(48000), null, "bottom = top + 35000 gives no hint");
  assert.equal(hookNearNote(withOverrides({ y_e5: 50000 }, withHookY(20000))), hint);
  assert.equal(hookNearNote(withOverrides({ y_e5: 55000 }, withHookY(20000))), null);
  assert.equal(hookNearNote(null), null);
  assert.equal(CAPTION_NOTES.hookNear, hint);
});
