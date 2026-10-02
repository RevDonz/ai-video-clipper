// 409 rebase (web/lib/editor/rebase.mjs, plan §4.5): the pending semantic commands are replayed
// onto the server's current document with every precondition re-checked; both edits survive
// (auto-merge) or a per-part dialog lists what really conflicts. QG-CONFLICT at unit level
// (plan §10.2): random two-tab scenarios never lose an edit silently, never lose the draft.
import assert from "node:assert/strict";
import test from "node:test";

import { loadContext, mulberry32, randomCommand, randomTwoTabs, runConflictProperty } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import { CommandRejected } from "../lib/editor/commands.mjs";
import { body, checkDoc, coldOpen, contentJson, hookItem } from "../lib/editor/doc-model.mjs";
import { createEditSession } from "../lib/editor/history.mjs";
import { GROUP_LABELS, PARTS, applyParts, diffParts, partGroup, partValue, partValues, rebase, replaySteps } from "../lib/editor/rebase.mjs";

const C30 = loadContext("c30");
const C25 = loadContext("c25");

function tab(context, doc = context.seed) {
  let t = 1000;
  const session = createEditSession({ doc, ctx: context.ctx, now: () => (t += 1000) });
  return session;
}

function bodyWords(context, doc = context.seed) {
  const seg = body(doc);
  return context.ctx.wordList.filter((_word, index) => {
    const mid = context.ctx.midSf(index);
    return mid >= seg.in_sf && mid < seg.out_sf;
  });
}

function rebaseTabs(context, mine, theirs) {
  return rebase({ base: context.seed, mine: mine.doc, theirs: theirs.doc, steps: mine.pending, ctx: context.ctx });
}

test("parts: diff, values and applyParts reconstruct a document exactly", () => {
  const rng = mulberry32(7);
  for (let round = 0; round < 150; round += 1) {
    const context = round % 2 ? C30 : C25;
    const a = tab(context);
    const b = tab(context);
    for (let i = 0; i < 12; i += 1) {
      for (const session of [a, b]) {
        const command = randomCommand(rng, session.doc, context);
        try {
          session.dispatch(command.type, command.args, command.options);
        } catch (error) {
          if (!(error instanceof CommandRejected)) throw error;
        }
      }
    }
    const parts = diffParts(b.doc, a.doc);
    const rebuilt = applyParts(b.doc, partValues(a.doc, parts), context.ctx);
    assert.equal(contentJson(rebuilt), contentJson(a.doc), `round ${round}: ${parts.join(",")}`);
    assert.deepEqual(diffParts(a.doc, a.doc), []);
  }
});

test("every part belongs to a labelled dialog group", () => {
  assert.equal(partGroup("hook.text"), "hook");
  assert.equal(partGroup("captions.override.y_e5"), "captions");
  assert.equal(partGroup("word:w048121.text"), "word:w048121");
  assert.equal(partGroup("removals:body"), "removals:body");
  assert.equal(partGroup("logo.transform"), "logo");
  assert.equal(partGroup("music.duck"), "music");
  assert.equal(partGroup("audio.master"), "audio");
  assert.equal(partGroup("join.style"), "join");
  assert.equal(partGroup("join.sfx"), "join");
  for (const group of ["trim", "coldopen", "join", "removals:body", "captions", "hook", "layout", "logo", "music", "audio"]) {
    assert.ok(GROUP_LABELS[group], group);
  }
  assert.equal(GROUP_LABELS.join, "Transisi cold open");
});

// --- the cold-open transition (docs/plans/2026-10-02-transisi-cold-open.md §7.3) ---------------

const WHOOSH = { id: "whoosh", v: 1 };

function c25WithColdOpen() {
  const words = bodyWords(C25);
  const session = tab(C25);
  session.dispatch("SetColdOpen", { firstWord: words[60].id, lastWord: words[64].id });
  return session.doc;
}

test("transition parts: set after the cold open, their values, and a new cold open's whoosh is a part", () => {
  const at = PARTS.indexOf("coldopen");
  assert.deepEqual(PARTS.slice(at, at + 3), ["coldopen", "join.style", "join.sfx"]);
  assert.equal(partValue(C30.seed, "join.style"), "cut");
  assert.equal(partValue(C30.seed, "join.sfx"), null);
  assert.equal(partValue(C25.seed, "join.style"), null);
  assert.equal(partValue(C25.seed, "join.sfx"), null);
  const auto = c25WithColdOpen();
  assert.equal(partValue(auto, "join.style"), "flash_white");
  assert.deepEqual(partValue(auto, "join.sfx"), WHOOSH);
  // A cold open without the whoosh differs from no cold open in join.sfx too, so rebuilding it
  // from parts never gets the template's whoosh.
  const quiet = applyParts(auto, { "join.sfx": null }, C25.ctx);
  assert.ok(!Object.hasOwn(quiet.main.joins[0], "sfx"));
  assert.deepEqual(diffParts(C25.seed, quiet).filter((part) => part.startsWith("join.") || part === "coldopen"),
    ["coldopen", "join.style", "join.sfx"]);
  const rebuilt = applyParts(C25.seed, partValues(quiet, diffParts(C25.seed, quiet)), C25.ctx);
  assert.equal(contentJson(rebuilt), contentJson(quiet));
  assert.equal(contentJson(applyParts(quiet, partValues(C25.seed, diffParts(quiet, C25.seed)), C25.ctx)), contentJson(C25.seed));
  // Style and sound need the cold open; null changes nothing without one.
  assert.throws(() => applyParts(C25.seed, { "join.style": "dip_black" }, C25.ctx), (error) => error.code === "cold_open_missing");
  assert.throws(() => applyParts(C25.seed, { "join.sfx": WHOOSH }, C25.ctx), (error) => error.code === "cold_open_missing");
  assert.equal(contentJson(applyParts(C25.seed, { "join.style": null, "join.sfx": null }, C25.ctx)), contentJson(C25.seed));
  // A cold open set as a part keeps the current join's transition (a trim does not reset it).
  const styled = applyParts(C30.seed, { "join.style": "dip_black", "join.sfx": WHOOSH }, C30.ctx);
  const moved = { ...partValue(C30.seed, "coldopen"), in_sf: coldOpen(C30.seed).in_sf + 3 };
  const trimmed = applyParts(styled, { coldopen: moved }, C30.ctx);
  assert.deepEqual(trimmed.main.joins, [{ after: "seg_co", style: "dip_black", audio_fade_ms: 30, sfx: WHOOSH }]);
});

test("a style chosen in one tab and a cold-open trim in the other both survive", () => {
  const mine = tab(C30);
  mine.dispatch("SetJoinStyle", { style: "dip_black" });
  mine.dispatch("SetJoinSfx", { on: true });
  const theirs = tab(C30);
  theirs.dispatch("NudgeColdOpen", { edge: "in", words: 1 });
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "merged");
  assert.equal(coldOpen(result.doc).in_sf, coldOpen(theirs.doc).in_sf);
  assert.deepEqual(result.doc.main.joins, [{ after: "seg_co", style: "dip_black", audio_fade_ms: 30, sfx: WHOOSH }]);
  assert.equal(contentJson(replaySteps(theirs.doc, result.steps, C30.ctx).doc), contentJson(result.doc));
  // And the other way round: my trim, their transition.
  const back = rebaseTabs(C30, theirs, mine);
  assert.equal(back.status, "merged");
  assert.equal(contentJson(back.doc), contentJson(result.doc));
});

test("both tabs choosing a style is one 'Transisi cold open' conflict; the same choice is none", () => {
  const mine = tab(C30);
  mine.dispatch("SetJoinStyle", { style: "dip_black" });
  const theirs = tab(C30);
  theirs.dispatch("SetJoinStyle", { style: "flash_white" });
  theirs.dispatch("SetJoinSfx", { on: true });
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts.map((group) => [group.id, group.label, group.parts]),
    [["join", "Transisi cold open", ["join.style"]]]);
  assert.equal(result.conflicts[0].mine, "Gelap sebentar");
  assert.equal(result.conflicts[0].theirs, "Kilat putih + whoosh");
  const mineWins = result.resolve({});
  assert.deepEqual(mineWins.doc.main.joins, [{ after: "seg_co", style: "dip_black", audio_fade_ms: 30, sfx: WHOOSH }]);
  assert.equal(contentJson(replaySteps(theirs.doc, mineWins.steps, C30.ctx).doc), contentJson(mineWins.doc));
  const theirsWin = result.resolve({ join: "theirs" });
  assert.equal(contentJson(theirsWin.doc), contentJson(theirs.doc));
  // The same style in both tabs, or the whoosh switched on in both, merges.
  const same = tab(C30);
  same.dispatch("SetJoinStyle", { style: "flash_white" });
  same.dispatch("SetJoinSfx", { on: true });
  const merged = rebaseTabs(C30, same, theirs);
  assert.equal(merged.status, "merged");
  assert.equal(contentJson(merged.doc), contentJson(theirs.doc));
});

test("a style set after the other tab removed the cold open is grouped with the cold open", () => {
  const mine = tab(C30);
  mine.dispatch("SetJoinStyle", { style: "dip_black" });
  mine.dispatch("SetJoinSfx", { on: true });
  const theirs = tab(C30);
  theirs.dispatch("SetColdOpen", null);
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts.map((group) => [group.id, group.label]), [["coldopen", "Cold open"]]);
  assert.deepEqual(result.conflicts[0].parts, ["coldopen", "join.style", "join.sfx"]);
  const mineWins = result.resolve({ coldopen: "mine" });
  assert.equal(coldOpen(mineWins.doc).in_sf, coldOpen(C30.seed).in_sf);
  assert.deepEqual(mineWins.doc.main.joins, [{ after: "seg_co", style: "dip_black", audio_fade_ms: 30, sfx: WHOOSH }]);
  assert.equal(contentJson(replaySteps(theirs.doc, mineWins.steps, C30.ctx).doc), contentJson(mineWins.doc));
  assert.equal(coldOpen(result.resolve({ coldopen: "theirs" }).doc), null);
});

test("a cold open brought back by 'Pakai punyaku' brings its transition along", () => {
  // Both tabs start from a saved revision with Gelap sebentar + whoosh; mine only trims the cold
  // open, theirs removes it: restoring mine restores the transition, not the seed's cut.
  const start = tab(C30);
  start.dispatch("SetJoinStyle", { style: "dip_black" });
  start.dispatch("SetJoinSfx", { on: true });
  const base = start.doc;
  const mine = tab(C30, base);
  mine.dispatch("NudgeColdOpen", { edge: "out", words: -1 });
  const theirs = tab(C30, base);
  theirs.dispatch("SetColdOpen", null);
  const result = rebase({ base, mine: mine.doc, theirs: theirs.doc, steps: mine.pending, ctx: C30.ctx });
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts.map((group) => [group.id, group.parts]), [["coldopen", ["coldopen", "join.style", "join.sfx"]]]);
  const mineWins = result.resolve({});
  assert.equal(contentJson(mineWins.doc), contentJson(mine.doc));
  assert.equal(contentJson(replaySteps(theirs.doc, mineWins.steps, C30.ctx).doc), contentJson(mineWins.doc));
});

test("edits of different parts in two tabs both survive", () => {
  const words = bodyWords(C30);
  const mine = tab(C30);
  mine.dispatch("SetHookText", { text: "Hook dari tab satu" });
  mine.dispatch("RemoveWords", { wordIds: [words[10].id] });
  mine.dispatch("SetWordEmphasis", { wordId: words[30].id, on: true });
  const theirs = tab(C30);
  theirs.dispatch("SetCaptionPack", { id: "bold" });
  theirs.dispatch("RemoveWords", { wordIds: [words[50].id, words[51].id] });
  theirs.dispatch("EditWordText", { wordId: words[40].id, text: "Ijal" });
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "merged");
  assert.deepEqual(checkDoc(result.doc, C30.ctx), []);
  assert.equal(hookItem(result.doc).payload.text, "Hook dari tab satu");
  assert.equal(result.doc.captions.pack.id, "bold");
  assert.equal(result.doc.main.removals.length, 2);
  assert.deepEqual(result.doc.captions.word_edits[words[40].id], { text: "Ijal" });
  assert.deepEqual(result.doc.captions.word_edits[words[30].id], { emphasis: true });
  // The rebased steps replay theirs into the merged document (the next 409 starts from here).
  assert.equal(contentJson(replaySteps(theirs.doc, result.steps, C30.ctx).doc), contentJson(result.doc));
});

test("the same part edited differently opens the per-part dialog", () => {
  const words = bodyWords(C30);
  const mine = tab(C30);
  mine.dispatch("SetHookText", { text: "Punyaku" });
  mine.dispatch("EditWordText", { wordId: words[5].id, text: "Ijal" });
  mine.dispatch("SetLayout", { mode: "camera" });
  const theirs = tab(C30);
  theirs.dispatch("SetHookText", { text: "Tersimpan" });
  theirs.dispatch("EditWordText", { wordId: words[5].id, text: "Ijai" });
  theirs.dispatch("SetCaptionOverride", { key: "y_e5", value: 70000 });
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts.map((group) => [group.id, group.label]), [
    ["word:" + words[5].id, "Caption kata 'Ijal'"],
    ["hook", "Teks hook"],
  ]);
  assert.deepEqual(result.conflicts[1].parts, ["hook.text"]);
  assert.equal(result.conflicts[1].mine, "Punyaku");
  assert.equal(result.conflicts[1].theirs, "Tersimpan");
  // Non-conflicting edits of both tabs are already in the partial document.
  assert.equal(result.doc.layout.default.mode, "camera");
  assert.equal(result.doc.captions.overrides.y_e5, 70000);
  const mineWins = result.resolve({});
  assert.equal(hookItem(mineWins.doc).payload.text, "Punyaku");
  assert.equal(mineWins.doc.captions.word_edits[words[5].id].text, "Ijal");
  assert.equal(mineWins.doc.captions.overrides.y_e5, 70000);
  const theirsWin = result.resolve({ hook: "theirs", [`word:${words[5].id}`]: "theirs" });
  assert.equal(hookItem(theirsWin.doc).payload.text, "Tersimpan");
  assert.equal(theirsWin.doc.layout.default.mode, "camera");
  const mixed = result.resolve({ hook: "theirs" });
  assert.equal(hookItem(mixed.doc).payload.text, "Tersimpan");
  assert.equal(mixed.doc.captions.word_edits[words[5].id].text, "Ijal");
  assert.equal(contentJson(replaySteps(theirs.doc, mixed.steps, C30.ctx).doc), contentJson(mixed.doc));
  assert.throws(() => result.resolve({ hook: "both" }), CommandRejected);
});

test("the same edit in both tabs is not a conflict", () => {
  const mine = tab(C30);
  mine.dispatch("SetLayout", { mode: "fill_center" });
  mine.dispatch("SetHookY", { y_e5: 20000 });
  const theirs = tab(C30);
  theirs.dispatch("SetLayout", { mode: "fill_center" });
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "merged");
  assert.equal(hookItem(result.doc).transform.y_e5, 20000);
});

test("a step whose precondition no longer holds becomes a labelled conflict", () => {
  const words = bodyWords(C30);
  const mine = tab(C30);
  mine.dispatch("RemoveWords", { wordIds: [words.at(-5).id] });
  const theirs = tab(C30);
  theirs.dispatch("TrimEnd", { gapWord: words.at(-20).id });
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "conflict");
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0].id, "removals:body");
  assert.match(result.conflicts[0].label, /^Potongan \d\d:\d\d$/);
  assert.equal(body(result.doc).out_sf, body(theirs.doc).out_sf);
  // "Pakai punyaku" for the cut cannot put it outside the saved trim: it is clamped away.
  const theirsWin = result.resolve({ "removals:body": "theirs" });
  assert.equal(contentJson(theirsWin.doc), contentJson(theirs.doc));
});

test("mine's trim and theirs' cut in the trimmed range", () => {
  const words = bodyWords(C30);
  const mine = tab(C30);
  mine.dispatch("TrimStart", { gapWord: words[20].id });
  const theirs = tab(C30);
  theirs.dispatch("RemoveWords", { wordIds: [words[5].id] });
  theirs.dispatch("RemoveWords", { wordIds: [words[40].id] });
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "merged");
  assert.equal(body(result.doc).in_sf, body(mine.doc).in_sf);
  assert.deepEqual(result.doc.main.removals.map((removal) => removal.words), [[words[40].id]]);
});

test("removal ids created by mine are remapped when theirs took them", () => {
  const words = bodyWords(C30);
  const mine = tab(C30);
  mine.dispatch("RemoveWords", { wordIds: [words[10].id] });
  mine.dispatch("RemoveWords", { wordIds: [words[20].id] });
  mine.dispatch("RestoreRemoval", { removalId: "rm_1" });
  const theirs = tab(C30);
  theirs.dispatch("RemoveWords", { wordIds: [words[60].id] });
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "merged");
  assert.deepEqual(result.doc.main.removals.map((removal) => removal.words).sort(), [[words[20].id], [words[60].id]].sort());
});

test("cold open replaced in one tab and nudged in the other", () => {
  const mine = tab(C30);
  mine.dispatch("NudgeColdOpen", { edge: "in", words: 1 });
  const theirs = tab(C30);
  theirs.dispatch("SetColdOpen", null);
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts.map((group) => group.id), ["coldopen"]);
  const mineWins = result.resolve({ coldopen: "mine" });
  assert.equal(coldOpen(mineWins.doc).in_sf, coldOpen(mine.doc).in_sf);
  assert.equal(mineWins.doc.main.joins.length, 1);
});

test("ResetToSeed replays as the parts it changed, not as a wipe of theirs' edits", () => {
  const mine = tab(C30);
  mine.dispatch("SetHookText", { text: "Sementara" });
  const base = mine.doc;
  mine.seal();
  mine.saved(mine.pending.length);
  mine.dispatch("ResetToSeed", {});
  const theirs = tab(C30, base);
  theirs.dispatch("SetLayout", { mode: "camera" });
  const result = rebase({ base, mine: mine.doc, theirs: theirs.doc, steps: mine.pending, ctx: C30.ctx });
  assert.equal(result.status, "merged");
  assert.equal(result.doc.layout.default.mode, "camera");
  assert.equal(hookItem(result.doc).payload.text, hookItem(C30.seed).payload.text);
  assert.equal(contentJson(replaySteps(theirs.doc, result.steps, C30.ctx).doc), contentJson(result.doc),
    "the rebased log replays to the merged document");
});

test("choosing 'mine' for a field of an item the other tab removed brings the item back", () => {
  const mine = tab(C30);
  mine.dispatch("SetHookDuration", { dur_f: 200 });
  const theirs = tab(C30);
  theirs.dispatch("SetHookEnabled", { on: false });
  const result = rebaseTabs(C30, mine, theirs);
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.conflicts.map((group) => group.id), ["hook"]);
  assert.ok(result.conflicts[0].parts.includes("hook.on"));
  const mineWins = result.resolve({});
  assert.equal(hookItem(mineWins.doc).dur_f, 200);
  assert.equal(hookItem(result.resolve({ hook: "theirs" }).doc), null);
  const words = bodyWords(C30);
  const co = coldOpen(C30.seed);
  const coWords = C30.ctx.wordList.filter((_word, index) => C30.ctx.midSf(index) >= co.in_sf && C30.ctx.midSf(index) < co.out_sf);
  const cutter = tab(C30);
  cutter.dispatch("RemoveWords", { wordIds: [coWords[2].id], seg: co.id });
  const remover = tab(C30);
  remover.dispatch("SetColdOpen", null);
  remover.dispatch("RemoveWords", { wordIds: [words[40].id] });
  const second = rebaseTabs(C30, cutter, remover);
  assert.equal(second.status, "conflict");
  assert.deepEqual(second.conflicts.map((group) => [group.id, group.label]), [["coldopen", "Cold open"]]);
  const keep = second.resolve({ coldopen: "mine" });
  assert.equal(coldOpen(keep.doc).id, co.id);
  assert.equal(keep.doc.main.removals.length, 2);
  assert.equal(contentJson(replaySteps(remover.doc, keep.steps, C30.ctx).doc), contentJson(keep.doc));
});

test("QG-CONFLICT (unit): 2,000 random two-tab scenarios lose no edit and always resolve", () => {
  const contexts = [loadContext("c30"), loadContext("c25"), loadContext("c24")];
  const summary = runConflictProperty({ contexts, scenarios: 2000, seed: 20260925 });
  assert.deepEqual(summary.examples, []);
  assert.equal(summary.problems, 0);
  assert.ok(summary.merged > 200, `only ${summary.merged} merges`);
  assert.ok(summary.conflicts > 200, `only ${summary.conflicts} conflicts`);
  assert.equal(summary.merged + summary.conflicts, 2000);
});

test("randomTwoTabs gives two independent tabs from one base", () => {
  const rng = mulberry32(3);
  const { base, mine, theirs } = randomTwoTabs(rng, C30, { mineSteps: 5, theirsSteps: 5 });
  assert.equal(base, C30.seed);
  assert.equal(contentJson(replaySteps(base, mine.pending, C30.ctx).doc), contentJson(mine.doc));
  assert.equal(contentJson(replaySteps(base, theirs.pending, C30.ctx).doc), contentJson(theirs.doc));
});
