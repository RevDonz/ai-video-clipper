// Appendix B commands (web/lib/editor/commands.mjs) and the document model helpers they use
// (web/lib/editor/doc-model.mjs): pure `(doc, args) → doc`, preconditions throw
// CommandRejected(code), every result keeps the plan §3.3/§3.4 rules (checkDoc) so the Python
// validator accepts it (the 1,000-sequence cross-check in tests/test_edit_v2_crosscheck.py).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { COMMANDS as FAKE_COMMANDS } from "../components/editor/__dev__/fakes.mjs";
import { loadContext } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import {
  COMMANDS,
  COMMAND_MESSAGES,
  CommandRejected,
  DUCK_PRESETS,
  applyCommand,
  clampLogoPosition,
  commandMessage,
  defaultMergeKey,
  defaultMusicGain,
} from "../lib/editor/commands.mjs";
import {
  EDITOR_ID,
  body,
  canonicalJson,
  checkDoc,
  coldOpen,
  contentEquals,
  contentJson,
  hookItem,
  logoItem,
  musicItem,
  nearestTrimWord,
  wordStatus,
} from "../lib/editor/doc-model.mjs";
import { logoBox, pieces, sfCeil, sfFloor } from "../lib/editor/timemap.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const contextsDir = path.join(root, "tests", "fixtures", "edit_v2", "docs", "contexts");

const C30 = loadContext("c30");
const C25 = loadContext("c25");
const C24 = loadContext("c24");
const ASSETS = C30.assets;
const LOGO = "sha256:036ce0c8d1bbde9427d03c28388f2f48cf1b4a1061869b334f0be2adee588148";
const LOGO_WIDE = "sha256:0736a9232e8ad3fdadacf971380804b79da31541b80f890636cda9b0ef7b9872";
const MUSIC = "sha256:f4eff9f785f6f6b1f32185191b7b66edb3cad91a7313650de54ea5cfdbb56472";
const MUSIC_SHORT = "sha256:1a2f0fb83c7c024249189e5bbabe991a28296cb0824405c5988cfaf7201e33d1";

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

function run(context, doc, type, args) {
  const result = applyCommand(deepFreeze(doc), type, args, context.ctx);
  assert.deepEqual(checkDoc(result.doc, context.ctx), [], `${type} produced an invalid document`);
  assert.equal(result.doc.audit.last_command, type);
  assert.equal(result.doc.audit.editor, EDITOR_ID);
  assert.equal(result.doc.revision, doc.revision);
  assert.equal(result.doc.parent_sha256, doc.parent_sha256);
  return result.doc;
}

function rejects(context, doc, type, args, code) {
  assert.throws(() => applyCommand(deepFreeze(doc), type, args, context.ctx), (error) => {
    assert.ok(error instanceof CommandRejected, `${type}: ${error}`);
    assert.equal(error.code, code, `${type}: expected ${code}, got ${error.code}`);
    assert.equal(error.message, commandMessage(code));
    return true;
  });
}

function wordsIn(context, segment) {
  const { ctx } = context;
  return ctx.wordList.filter((_word, index) => {
    const mid = ctx.midSf(index);
    return mid >= segment.in_sf && mid < segment.out_sf;
  });
}

const idx = (context, word) => context.ctx.indexOf(word.id);

function bodyFrames(doc) {
  const seg = body(doc);
  return pieces(doc).filter((piece) => piece.seg === seg.id).reduce((sum, piece) => sum + piece.frames, 0);
}

// --- model ---------------------------------------------------------------------------------

test("the command list is Appendix B, the same 35 names the fakes know", () => {
  assert.deepEqual([...COMMANDS], [...FAKE_COMMANDS]);
  assert.equal(COMMANDS.length, 35);
  for (const [code, message] of Object.entries(COMMAND_MESSAGES)) {
    assert.match(code, /^[a-z_]+$/);
    assert.ok(message.length > 5, code);
  }
});

test("canonicalJson reproduces Python's canonical bytes of every context seed", () => {
  for (const id of ["c30", "c25", "c24"]) {
    const raw = readFileSync(path.join(contextsDir, `${id}.seed.json`), "utf8");
    assert.equal(canonicalJson(JSON.parse(raw)), raw);
  }
  assert.equal(canonicalJson({ b: [2, { d: "é\n\"", c: null }], a: true }), '{"a":true,"b":[2,{"c":null,"d":"é\\n\\""}]}');
});

test("the context seeds pass checkDoc and a broken document does not", () => {
  for (const context of [C30, C25, C24]) assert.deepEqual(checkDoc(context.seed, context.ctx), []);
  const broken = structuredClone(C30.seed);
  body(broken).out_sf = body(broken).in_sf + 30;
  assert.ok(checkDoc(broken, C30.ctx).some((issue) => issue.code === "duration_out_of_bounds"));
  const joinless = structuredClone(C30.seed);
  joinless.main.joins = [];
  assert.ok(checkDoc(joinless, C30.ctx).some((issue) => issue.code === "cold_open_invalid"));
});

test("contentEquals ignores revision, parent and audit (R10)", () => {
  const edited = { ...C30.seed, revision: 7, parent_sha256: "a".repeat(64), audit: { ...C30.seed.audit, last_command: "X" } };
  assert.ok(contentEquals(edited, C30.seed));
  assert.equal(contentJson(edited), contentJson(C30.seed));
  assert.ok(!contentEquals({ ...edited, layout: { default: { mode: "camera", no_face: "center" } } }, C30.seed));
});

test("wordStatus and nearestTrimWord describe the transcript through the time map", () => {
  const seg = body(C30.seed);
  const inside = wordsIn(C30, seg);
  const target = inside[20];
  const doc = run(C30, C30.seed, "RemoveWords", { wordIds: [target.id] });
  const status = wordStatus(doc, C30.ctx);
  assert.equal(status.get(target.id).removal, "rm_1");
  assert.equal(status.get(target.id).visibleIn, null);
  assert.equal(status.get(inside[21].id).visibleIn, "seg_b1");
  assert.equal(status.get(C30.ctx.wordList[0].id).visibleIn, null);
  const i = idx(C30, inside[30]);
  const sf = C30.ctx.boundBefore(i).sf;
  assert.equal(nearestTrimWord(C30.ctx, sf, "start"), inside[30].id);
  assert.equal(nearestTrimWord(C30.ctx, C30.ctx.boundAfter(i).sf, "end"), inside[30].id);
});

// --- purity and dispatch contract ----------------------------------------------------------

test("commands are pure, stamp audit and keep revision and parent", () => {
  const doc = { ...structuredClone(C30.seed), revision: 3, parent_sha256: "b".repeat(64) };
  const before = canonicalJson(doc);
  const next = run(C30, doc, "SetLayout", { mode: "camera" });
  assert.equal(canonicalJson(doc), before);
  assert.equal(next.layout.default.mode, "camera");
  assert.equal(next.main, doc.main, "unchanged parts are shared, not copied");
  assert.equal(next.captions, doc.captions);
});

test("unknown commands and malformed arguments are rejected", () => {
  rejects(C30, C30.seed, "Explode", {}, "unknown_command");
  rejects(C30, C30.seed, "SetLayout", null, "invalid_args");
  rejects(C30, C30.seed, "SetLayout", { mode: 3 }, "value_out_of_range");
  rejects(C30, C30.seed, "RemoveWords", { wordIds: "w048100" }, "invalid_args");
  rejects(C30, C30.seed, "SetHookDuration", { dur_f: 120.5 }, "invalid_args");
});

test("defaultMergeKey follows Appendix B", () => {
  assert.equal(defaultMergeKey("NudgeColdOpen", { edge: "in", words: 1 }), "co:in");
  assert.equal(defaultMergeKey("EditWordText", { wordId: "w048100", text: "x" }), "word:w048100");
  assert.equal(defaultMergeKey("SetCaptionOverride", { key: "y_e5", value: 80000 }), "cap:y_e5");
  assert.equal(defaultMergeKey("SetHookText", { text: "x" }), "hook:text");
  assert.equal(defaultMergeKey("SetHookDuration", { dur_f: 90 }), "hook:dur");
  assert.equal(defaultMergeKey("SetHookY", { y_e5: 9000 }), "hook:y");
  assert.equal(defaultMergeKey("MoveLogo", { x_e5: 1, y_e5: 2 }), "logo:move");
  assert.equal(defaultMergeKey("ResizeLogo", { w_e5: 9000 }), "logo:size");
  assert.equal(defaultMergeKey("SetLogoOpacity", { opacity_pm: 900 }), "logo:opacity");
  assert.equal(defaultMergeKey("SetMusicGain", { gain_cdb: -100 }), "music:gain");
  assert.equal(defaultMergeKey("SetDuck", { depth_cdb: 900 }), "music:duck");
  assert.equal(defaultMergeKey("SetSourceGain", { gain_cdb: 100 }), "audio:source");
  assert.equal(defaultMergeKey("SetLoudness", { mode: "off" }), "audio:master");
  for (const type of ["TrimStart", "TrimEnd", "RemoveWords", "RemoveGap", "RestoreRemoval", "ApplyCleanup",
    "SetColdOpen", "SetWordHidden", "SetWordEmphasis", "SetCaptionPack", "SetLayout", "SetLogo", "RemoveLogo",
    "SnapLogo", "SetMusic", "RemoveMusic", "ResetToSeed"]) {
    assert.equal(defaultMergeKey(type, {}), null, type);
  }
});

// --- trims ---------------------------------------------------------------------------------

test("TrimStart and TrimEnd move the body edge to the bounds frame of the word gap", () => {
  const inside = wordsIn(C30, body(C30.seed));
  const first = inside[10];
  const trimmed = run(C30, C30.seed, "TrimStart", { gapWord: first.id });
  assert.equal(body(trimmed).in_sf, C30.ctx.boundBefore(idx(C30, first)).sf);
  const last = inside.at(-10);
  const ended = run(C30, trimmed, "TrimEnd", { gapWord: last.id });
  assert.equal(body(ended).out_sf, C30.ctx.boundAfter(idx(C30, last)).sf);
  assert.equal(body(ended).in_sf, body(trimmed).in_sf);
  // Extending into the context words (outside the body) is allowed within the window.
  const earlier = C30.ctx.wordList[2];
  assert.equal(body(run(C30, C30.seed, "TrimStart", { gapWord: earlier.id })).in_sf, C30.ctx.boundBefore(2).sf);
});

test("trims keep the body between 3 s and 300 s and the cold-open rules", () => {
  const seg = body(C30.seed);
  const late = C30.ctx.wordList.find((_word, index) => C30.ctx.boundBefore(index).sf > seg.out_sf - 60);
  rejects(C30, C30.seed, "TrimStart", { gapWord: late.id }, "duration_out_of_bounds");
  rejects(C30, C30.seed, "TrimEnd", { gapWord: C30.ctx.wordList[0].id }, "range_invalid");
  // Starting the body where the cold open starts would make the cold open repeat the opening.
  const co = coldOpen(C30.seed);
  const coWord = C30.ctx.wordList.find((_word, index) => C30.ctx.boundBefore(index).sf >= co.in_sf);
  rejects(C30, C30.seed, "TrimStart", { gapWord: coWord.id }, "cold_open_invalid");
  rejects(C30, C30.seed, "TrimStart", { gapWord: "w999999" }, "unknown_word");
  // c25: 300 s is the ceiling (25 fps: 7,500 frames).
  const words = C25.ctx.wordList;
  let doc = run(C25, C25.seed, "TrimStart", { gapWord: words[0].id });
  const tooLong = words.findLast((_word, index) => C25.ctx.boundAfter(index).sf - body(doc).in_sf > sfFloor(300000, [25, 1]));
  rejects(C25, doc, "TrimEnd", { gapWord: tooLong.id }, "duration_out_of_bounds");
});

test("trims clamp or drop the body removals they cross", () => {
  const inside = wordsIn(C30, body(C30.seed));
  let doc = run(C30, C30.seed, "RemoveWords", { wordIds: [inside[5].id, inside[6].id] });
  doc = run(C30, doc, "RemoveWords", { wordIds: [inside[40].id] });
  assert.equal(doc.main.removals.length, 2);
  const trimmed = run(C30, doc, "TrimStart", { gapWord: inside[20].id });
  assert.deepEqual(trimmed.main.removals.map((removal) => removal.words), [[inside[40].id]]);
  const inRemoval = run(C30, doc, "TrimStart", { gapWord: inside[6].id });
  assert.equal(inRemoval.main.removals[0].in_sf, body(inRemoval).in_sf);
});

// --- removals ------------------------------------------------------------------------------

test("RemoveWords removes a contiguous run from bounds to bounds", () => {
  const inside = wordsIn(C30, body(C30.seed));
  const run3 = inside.slice(30, 33);
  const doc = run(C30, C30.seed, "RemoveWords", { wordIds: run3.map((word) => word.id) });
  assert.deepEqual(doc.main.removals, [{
    id: "rm_1", seg: "seg_b1", in_sf: C30.ctx.boundBefore(idx(C30, run3[0])).sf,
    out_sf: C30.ctx.boundAfter(idx(C30, run3[2])).sf, words: run3.map((word) => word.id), reason: "user", origin: "user",
  }]);
  const suggested = run(C30, C30.seed, "RemoveWords", { wordIds: [run3[1].id], reason: "filler", origin: "suggestion:cl_7" });
  assert.equal(suggested.main.removals[0].reason, "filler");
  assert.equal(suggested.main.removals[0].origin, "suggestion:cl_7");
  rejects(C30, C30.seed, "RemoveWords", { wordIds: [run3[0].id], reason: "boring" }, "invalid_args");
  rejects(C30, C30.seed, "RemoveWords", { wordIds: [run3[0].id], origin: "suggestion:BAD" }, "invalid_args");
});

test("RemoveWords merges with touching and overlapping removals", () => {
  const inside = wordsIn(C30, body(C30.seed));
  let doc = run(C30, C30.seed, "RemoveWords", { wordIds: [inside[30].id, inside[31].id] });
  doc = run(C30, doc, "RemoveWords", { wordIds: [inside[32].id] });
  assert.equal(doc.main.removals.length, 1);
  assert.deepEqual(doc.main.removals[0].words, [inside[30].id, inside[31].id, inside[32].id]);
  assert.equal(doc.main.removals[0].in_sf, C30.ctx.boundBefore(idx(C30, inside[30])).sf);
  assert.equal(doc.main.removals[0].out_sf, C30.ctx.boundAfter(idx(C30, inside[32])).sf);
  doc = run(C30, doc, "RemoveWords", { wordIds: inside.slice(31, 36).map((word) => word.id) });
  assert.equal(doc.main.removals.length, 1);
  assert.equal(doc.main.removals[0].words.length, 6);
  rejects(C30, doc, "RemoveWords", { wordIds: [inside[33].id] }, "nothing_to_remove");
});

test("RemoveWords preconditions: contiguous, inside one segment, visible, body ≥ 3 s", () => {
  const inside = wordsIn(C30, body(C30.seed));
  rejects(C30, C30.seed, "RemoveWords", { wordIds: [inside[1].id, inside[3].id] }, "not_contiguous");
  rejects(C30, C30.seed, "RemoveWords", { wordIds: [] }, "invalid_args");
  rejects(C30, C30.seed, "RemoveWords", { wordIds: ["w999999"] }, "unknown_word");
  rejects(C30, C30.seed, "RemoveWords", { wordIds: [C30.ctx.wordList[0].id] }, "removal_outside_segment");
  rejects(C30, C30.seed, "RemoveWords", { wordIds: inside.slice(0, -1).map((word) => word.id) }, "duration_out_of_bounds");
  // The first body word: the removal starts at the body edge, never before it.
  const doc = run(C30, C30.seed, "RemoveWords", { wordIds: [inside[0].id] });
  assert.ok(doc.main.removals[0].in_sf >= body(doc).in_sf);
});

test("RemoveWords works in the cold open and keeps it ≥ 0.5 s", () => {
  const co = coldOpen(C30.seed);
  const coWords = wordsIn(C30, co);
  assert.ok(coWords.length >= 3);
  const doc = run(C30, C30.seed, "RemoveWords", { wordIds: [coWords[1].id], seg: co.id });
  assert.equal(doc.main.removals[0].seg, co.id);
  rejects(C30, C30.seed, "RemoveWords", { wordIds: coWords.map((word) => word.id), seg: co.id }, "cold_open_invalid");
});

test("a removal holds at most 400 words: longer runs become touching removals", () => {
  const words = C25.ctx.wordList;
  let doc = run(C25, C25.seed, "TrimStart", { gapWord: words[0].id });
  const last = words.findLast((_word, index) => C25.ctx.boundAfter(index).sf - body(doc).in_sf <= sfFloor(300000, [25, 1]));
  doc = run(C25, doc, "TrimEnd", { gapWord: last.id });
  const inside = wordsIn(C25, body(doc));
  assert.ok(inside.length > 460, `only ${inside.length} words`);
  const run450 = inside.slice(5, 455).map((word) => word.id);
  doc = run(C25, doc, "RemoveWords", { wordIds: run450 });
  assert.equal(doc.main.removals.length, 2);
  assert.deepEqual(doc.main.removals.map((removal) => removal.words.length), [400, 50]);
  assert.equal(doc.main.removals[0].out_sf, doc.main.removals[1].in_sf);
  assert.ok(bodyFrames(doc) >= sfCeil(3000, [25, 1]));
});

test("at most 2,000 removals", () => {
  const doc = structuredClone(C25.seed);
  doc.main.removals = Array.from({ length: 2000 }, (_value, k) => ({
    id: `rm_${k + 1}`, seg: "seg_b1", in_sf: 15000 + 2 * k, out_sf: 15001 + 2 * k, words: [], reason: "gap_silent", origin: "user",
  }));
  assert.deepEqual(checkDoc(doc, C25.ctx), []);
  const target = wordsIn(C25, { in_sf: 19500, out_sf: 20000 })[3];
  rejects(C25, doc, "RemoveWords", { wordIds: [target.id] }, "too_many_removals");
});

function silentGapInBody(context, skip = 0) {
  const { ctx } = context;
  const seg = body(context.seed);
  return context.words.gaps.filter((gap) => {
    const i = ctx.indexOf(gap.after);
    return gap.class === "silent" && ctx.midSf(i) >= seg.in_sf && ctx.midSf(i + 1) < seg.out_sf;
  })[skip];
}

test("RemoveGap removes frames inside a word gap and never near laughter", () => {
  const { ctx } = C30;
  const silent = silentGapInBody(C30);
  const i = ctx.indexOf(silent.after);
  const lo = sfCeil(ctx.wordList[i].e, [30000, 1001]);
  const hi = sfFloor(ctx.wordList[i + 1].s, [30000, 1001]);
  assert.ok(hi - lo >= 4);
  const doc = run(C30, C30.seed, "RemoveGap", { afterWord: silent.after, inSf: lo + 1, outSf: hi - 1, origin: "suggestion:cl_3" });
  assert.deepEqual(doc.main.removals[0], {
    id: "rm_1", seg: "seg_b1", in_sf: lo + 1, out_sf: hi - 1, words: [], reason: "gap_silent", origin: "suggestion:cl_3",
  });
  rejects(C30, C30.seed, "RemoveGap", { afterWord: silent.after, inSf: lo - 1, outSf: hi }, "gap_invalid");
  rejects(C30, C30.seed, "RemoveGap", { afterWord: silent.after, inSf: lo, outSf: lo }, "gap_invalid");
  const laugh = C30.words.gaps.find((gap) => gap.class === "laughter");
  const j = ctx.indexOf(laugh.after);
  const llo = sfCeil(ctx.wordList[j].e, [30000, 1001]);
  rejects(C30, C30.seed, "RemoveGap", { afterWord: laugh.after, inSf: llo, outSf: llo + 2 }, "laughter_locked");
});

test("RestoreRemoval: delete then restore is byte-identical", () => {
  const inside = wordsIn(C30, body(C30.seed));
  const removed = run(C30, C30.seed, "RemoveWords", { wordIds: [inside[50].id, inside[51].id] });
  const restored = run(C30, removed, "RestoreRemoval", { removalId: removed.main.removals[0].id });
  assert.equal(contentJson(restored), contentJson(C30.seed));
  rejects(C30, C30.seed, "RestoreRemoval", { removalId: "rm_9" }, "removal_missing");
});

test("RestoreRemoval keeps the body ≤ 300 s", () => {
  const words = C25.ctx.wordList;
  let doc = run(C25, C25.seed, "TrimStart", { gapWord: words[0].id });
  const limit = sfFloor(300000, [25, 1]);
  const fits = words.findLast((_word, index) => C25.ctx.boundAfter(index).sf - body(doc).in_sf <= limit);
  doc = run(C25, doc, "TrimEnd", { gapWord: fits.id });
  const inside = wordsIn(C25, body(doc));
  doc = run(C25, doc, "RemoveWords", { wordIds: inside.slice(100, 140).map((word) => word.id) });
  const next = words[C25.ctx.indexOf(fits.id) + 8];
  doc = run(C25, doc, "TrimEnd", { gapWord: next.id });
  assert.ok(body(doc).out_sf - body(doc).in_sf > limit);
  rejects(C25, doc, "RestoreRemoval", { removalId: doc.main.removals[0].id }, "duration_out_of_bounds");
});

test("ApplyCleanup applies every item as one transaction or none", () => {
  const { ctx } = C30;
  const inside = wordsIn(C30, body(C30.seed));
  const silent = silentGapInBody(C30, 1);
  const i = ctx.indexOf(silent.after);
  const lo = sfCeil(ctx.wordList[i].e, [30000, 1001]);
  const hi = sfFloor(ctx.wordList[i + 1].s, [30000, 1001]);
  const items = [
    { id: "cl_1", kind: "filler", wordIds: [inside[12].id] },
    { id: "cl_2", kind: "repeat", wordIds: [inside[60].id, inside[61].id] },
    { id: "cl_3", kind: "gap_silent", afterWord: silent.after, inSf: lo + 1, outSf: hi - 1 },
  ];
  const result = applyCommand(deepFreeze(structuredClone(C30.seed)), "ApplyCleanup", { items }, ctx);
  assert.deepEqual(checkDoc(result.doc, ctx), []);
  assert.deepEqual(result.doc.main.removals.map((removal) => [removal.reason, removal.origin]).sort(), [
    ["filler", "suggestion:cl_1"], ["gap_silent", "suggestion:cl_3"], ["repeat", "suggestion:cl_2"],
  ]);
  assert.equal(result.args.items.length, 3);
  assert.ok(result.args.items.every((item) => /^rm_[0-9]+$/.test(item.removalId)));
  assert.throws(() => applyCommand(C30.seed, "ApplyCleanup", { items: [items[0], { id: "cl_9", kind: "filler", wordIds: ["w999999"] }] }, ctx),
    (error) => error instanceof CommandRejected && error.code === "unknown_word" && error.detail.item === 1);
  rejects(C30, C30.seed, "ApplyCleanup", { items: [] }, "nothing_to_apply");
  rejects(C30, C30.seed, "ApplyCleanup", { items: [{ id: "cl_1", kind: "gap_voiced", wordIds: [inside[1].id] }] }, "invalid_args");
});

// --- cold open -----------------------------------------------------------------------------

function coWordsAt(context, fromSec, maxSec) {
  const { ctx } = context;
  const fps = context.seed.output.fps;
  const seg = body(context.seed);
  const start = ctx.wordList.findIndex((_word, index) => ctx.boundBefore(index).sf >= seg.in_sf + sfCeil(fromSec * 1000, fps));
  let end = start;
  while (ctx.boundAfter(end + 1).sf - ctx.boundBefore(start).sf <= sfFloor(maxSec * 1000, fps)) end += 1;
  return [ctx.wordList[start], ctx.wordList[end]];
}

test("SetColdOpen builds the cold open from bounds with a 30 ms cut join", () => {
  const [first, last] = coWordsAt(C25, 40, 4);
  const doc = run(C25, C25.seed, "SetColdOpen", { firstWord: first.id, lastWord: last.id });
  assert.deepEqual(doc.main.segments[0], {
    id: "seg_co", role: "cold_open", in_sf: C25.ctx.boundBefore(idx(C25, first)).sf, out_sf: C25.ctx.boundAfter(idx(C25, last)).sf,
  });
  assert.equal(doc.main.segments[1].role, "body");
  assert.deepEqual(doc.main.joins, [{ after: "seg_co", style: "cut", audio_fade_ms: 30 }]);
  const cleared = run(C25, doc, "SetColdOpen", null);
  assert.equal(contentJson(cleared), contentJson(C25.seed));
});

test("SetColdOpen enforces 0.5–8 s and refuses to repeat the opening", () => {
  const { ctx } = C25;
  const seg = body(C25.seed);
  const short = ctx.wordList.find((_word, index) => ctx.midSf(index) > seg.in_sf + 200
    && ctx.boundAfter(index).sf - ctx.boundBefore(index).sf < sfCeil(500, [25, 1]));
  rejects(C25, C25.seed, "SetColdOpen", { firstWord: short.id, lastWord: short.id }, "cold_open_invalid");
  const [first] = coWordsAt(C25, 40, 4);
  const far = ctx.wordList[ctx.indexOf(first.id) + 60];
  rejects(C25, C25.seed, "SetColdOpen", { firstWord: first.id, lastWord: far.id }, "cold_open_invalid");
  const opening = wordsIn(C25, seg);
  rejects(C25, C25.seed, "SetColdOpen", { firstWord: opening[0].id, lastWord: opening[5].id }, "cold_open_invalid");
  rejects(C25, C25.seed, "SetColdOpen", { firstWord: far.id, lastWord: first.id }, "invalid_args");
});

test("replacing or removing the cold open drops its removals", () => {
  const co = coldOpen(C30.seed);
  const coWords = wordsIn(C30, co);
  const doc = run(C30, C30.seed, "RemoveWords", { wordIds: [coWords[1].id], seg: co.id });
  const cleared = run(C30, doc, "SetColdOpen", null);
  assert.deepEqual(cleared.main.segments.map((segment) => segment.role), ["body"]);
  assert.deepEqual(cleared.main.removals, []);
  assert.deepEqual(cleared.main.joins, []);
  const noChange = applyCommand(C25.seed, "SetColdOpen", null, C25.ctx).doc;
  assert.equal(contentJson(noChange), contentJson(C25.seed));
});

test("NudgeColdOpen moves one edge by whole word gaps", () => {
  const co = coldOpen(C30.seed);
  const sfs = C30.ctx.boundSfs;
  const later = run(C30, C30.seed, "NudgeColdOpen", { edge: "in", words: 1 });
  assert.equal(coldOpen(later).in_sf, sfs.find((sf) => sf > co.in_sf));
  const earlier = run(C30, C30.seed, "NudgeColdOpen", { edge: "out", words: -1 });
  assert.equal(coldOpen(earlier).out_sf, sfs.findLast((sf) => sf < co.out_sf));
  const twice = run(C30, later, "NudgeColdOpen", { edge: "in", words: 1 });
  assert.equal(coldOpen(twice).in_sf, sfs.filter((sf) => sf > co.in_sf)[1]);
  rejects(C25, C25.seed, "NudgeColdOpen", { edge: "in", words: 1 }, "cold_open_missing");
  rejects(C30, C30.seed, "NudgeColdOpen", { edge: "middle", words: 1 }, "invalid_args");
  rejects(C30, C30.seed, "NudgeColdOpen", { edge: "in", words: 0 }, "invalid_args");
  rejects(C30, C30.seed, "NudgeColdOpen", { edge: "in", words: 40 }, "cold_open_invalid");
});

// --- captions ------------------------------------------------------------------------------

test("EditWordText normalises, validates and drops edits equal to the ASR text", () => {
  const word = wordsIn(C30, body(C30.seed))[3];
  const doc = run(C30, C30.seed, "EditWordText", { wordId: word.id, text: "  Ijal " });
  assert.deepEqual(doc.captions.word_edits, { [word.id]: { text: "Ijal" } });
  const nfc = run(C30, C30.seed, "EditWordText", { wordId: word.id, text: "Café" });
  assert.equal(nfc.captions.word_edits[word.id].text, "Café");
  const back = run(C30, doc, "EditWordText", { wordId: word.id, text: word.t });
  assert.deepEqual(back.captions.word_edits, {});
  const emoji = run(C30, C30.seed, "EditWordText", { wordId: word.id, text: "😂".repeat(40) });
  assert.equal([...emoji.captions.word_edits[word.id].text].length, 40);
  rejects(C30, C30.seed, "EditWordText", { wordId: word.id, text: "😂".repeat(41) }, "text_too_long");
  rejects(C30, C30.seed, "EditWordText", { wordId: word.id, text: "   " }, "text_empty");
  rejects(C30, C30.seed, "EditWordText", { wordId: word.id, text: "a\u0007b" }, "text_invalid");
  rejects(C30, C30.seed, "EditWordText", { wordId: word.id, text: "a\ud800b" }, "text_invalid");
  rejects(C30, C30.seed, "EditWordText", { wordId: "w999999", text: "x" }, "unknown_word");
});

test("SetWordHidden and SetWordEmphasis set flags and drop empty entries", () => {
  const word = wordsIn(C30, body(C30.seed))[4];
  let doc = run(C30, C30.seed, "SetWordHidden", { wordId: word.id, on: true });
  assert.deepEqual(doc.captions.word_edits[word.id], { hidden: true });
  doc = run(C30, doc, "SetWordEmphasis", { wordId: word.id, on: true });
  doc = run(C30, doc, "EditWordText", { wordId: word.id, text: "Kata" });
  assert.deepEqual(doc.captions.word_edits[word.id], { emphasis: true, hidden: true, text: "Kata" });
  doc = run(C30, doc, "SetWordHidden", { wordId: word.id, on: false });
  doc = run(C30, doc, "SetWordEmphasis", { wordId: word.id, on: false });
  assert.deepEqual(doc.captions.word_edits, { [word.id]: { text: "Kata" } });
  doc = run(C30, doc, "EditWordText", { wordId: word.id, text: word.t });
  assert.deepEqual(doc.captions.word_edits, {});
  rejects(C30, C30.seed, "SetWordHidden", { wordId: word.id, on: "yes" }, "invalid_args");
  rejects(C30, C30.seed, "SetWordEmphasis", { wordId: "w999999", on: true }, "unknown_word");
});

test("caption packs, overrides and the enabled flag", () => {
  let doc = run(C30, C30.seed, "SetCaptionsEnabled", { on: false });
  assert.equal(doc.captions.enabled, false);
  doc = run(C30, C30.seed, "SetCaptionPack", { id: "bold" });
  assert.deepEqual(doc.captions.pack, { id: "bold", v: 1 });
  assert.equal(doc.captions.overrides.case, "upper", "Bold is upper-case by default");
  doc = run(C30, doc, "SetCaptionPack", { id: "box" });
  assert.equal(doc.captions.overrides.case, "asis");
  doc = run(C30, doc, "SetCaptionOverride", { key: "case", value: "upper" });
  doc = run(C30, doc, "SetCaptionPack", { id: "classic" });
  assert.equal(doc.captions.overrides.case, "upper", "a user choice survives a pack switch");
  rejects(C30, C30.seed, "SetCaptionPack", { id: "neon" }, "pack_unknown");
  const ranges = [["y_e5", 20000, 19999], ["y_e5", 92000, 92001], ["size_pm", 700, 699], ["size_pm", 1400, 1401],
    ["highlight", "#FFFFFF", "#123456"], ["emphasis", "#3DF5A6", "#ff5c8a"], ["case", "asis", "lower"]];
  for (const [key, good, bad] of ranges) {
    assert.equal(run(C30, C30.seed, "SetCaptionOverride", { key, value: good }).captions.overrides[key], good);
    rejects(C30, C30.seed, "SetCaptionOverride", { key, value: bad }, "value_out_of_range");
  }
  rejects(C30, C30.seed, "SetCaptionOverride", { key: "font", value: 1 }, "invalid_args");
  rejects(C30, C30.seed, "SetCaptionsEnabled", { on: 1 }, "invalid_args");
});

// --- hook ----------------------------------------------------------------------------------

test("the hook can be switched off and back on to the AI version", () => {
  const off = run(C30, C30.seed, "SetHookEnabled", { on: false });
  assert.equal(hookItem(off), null);
  assert.ok(!off.tracks.some((track) => track.kind === "hook"));
  const on = run(C30, off, "SetHookEnabled", { on: true });
  assert.equal(contentJson(on), contentJson(C30.seed));
  const custom = run(C30, off, "SetHookEnabled", { on: true, text: "Teks baru" });
  assert.equal(hookItem(custom).payload.text, "Teks baru");
  assert.equal(hookItem(custom).origin, "user");
});

test("a clip without a seed hook gets the default 4 s hook", () => {
  const doc = run(C25, C25.seed, "SetHookEnabled", { on: true, text: "Pokoknya jangan pulang dulu" });
  assert.deepEqual(doc.tracks, [{ id: "tr_hook", kind: "hook", items: [{
    id: "it_hook", type: "hook", start: { at: "out", f: 0 }, dur_f: 100, transform: { x_e5: 50000, y_e5: 13000 },
    payload: { text: "Pokoknya jangan pulang dulu", design: { id: "legacy-bar", v: 1 } }, origin: "user",
  }] }]);
  rejects(C25, C25.seed, "SetHookEnabled", { on: true }, "text_empty");
  rejects(C25, C25.seed, "SetHookText", { text: "x" }, "hook_missing");
  rejects(C25, C25.seed, "SetHookDuration", { dur_f: 50 }, "hook_missing");
  rejects(C25, C25.seed, "SetHookY", { y_e5: 9000 }, "hook_missing");
});

test("hook text, duration and position follow §3.3", () => {
  const seedText = hookItem(C30.seed).payload.text;
  let doc = run(C30, C30.seed, "SetHookText", { text: "Sutradara ditahan security", origin: "suggestion:sg_2" });
  assert.equal(hookItem(doc).payload.text, "Sutradara ditahan security");
  assert.equal(hookItem(doc).origin, "suggestion:sg_2");
  doc = run(C30, doc, "SetHookText", { text: seedText });
  assert.equal(contentJson(doc), contentJson(C30.seed), "typing the AI text back restores the seed origin");
  assert.equal(run(C30, C30.seed, "SetHookText", { text: "x".repeat(90) }).tracks[0].items[0].payload.text.length, 90);
  rejects(C30, C30.seed, "SetHookText", { text: "x".repeat(91) }, "text_too_long");
  rejects(C30, C30.seed, "SetHookText", { text: "ok", origin: "robot" }, "invalid_args");
  const max = sfFloor(30000, [30000, 1001]);
  assert.equal(hookItem(run(C30, C30.seed, "SetHookDuration", { dur_f: 15 })).dur_f, 15);
  assert.equal(hookItem(run(C30, C30.seed, "SetHookDuration", { dur_f: max })).dur_f, max);
  rejects(C30, C30.seed, "SetHookDuration", { dur_f: 14 }, "value_out_of_range");
  rejects(C30, C30.seed, "SetHookDuration", { dur_f: max + 1 }, "value_out_of_range");
  assert.equal(hookItem(run(C30, C30.seed, "SetHookY", { y_e5: 6000 })).transform.y_e5, 6000);
  rejects(C30, C30.seed, "SetHookY", { y_e5: 40001 }, "value_out_of_range");
});

// --- layout, logo, music, audio ------------------------------------------------------------

test("SetLayout switches between the three layouts", () => {
  for (const mode of ["fit_blur", "camera", "fill_center"]) {
    const doc = applyCommand(C30.seed, "SetLayout", { mode }, C30.ctx).doc;
    assert.deepEqual(doc.layout, { default: { mode, no_face: "center" } });
  }
  rejects(C30, C30.seed, "SetLayout", { mode: "split" }, "value_out_of_range");
});

test("SetLogo places the logo top-right inside the frame and registers the asset", () => {
  const doc = run(C30, C30.seed, "SetLogo", { asset: LOGO, meta: ASSETS[LOGO] });
  assert.deepEqual(doc.tracks.map((track) => track.id), ["tr_hook", "tr_ovr"]);
  assert.deepEqual(logoItem(doc), {
    id: "it_logo", type: "image", start: { at: "clip_start" }, end: { at: "clip_end" },
    transform: { x_e5: 88000, y_e5: 7000, w_e5: 16000, opacity_pm: 850 }, payload: { asset: LOGO, mode: "free" }, origin: "user",
  });
  assert.deepEqual(doc.assets, { [LOGO]: ASSETS[LOGO] });
  // The upload DTO form (bare hex, camelCase, kind "logo") gives the same document.
  const dto = { sha256: LOGO.slice(7), kind: "logo", mime: "image/png", w: 512, h: 512, durationMs: null, lufsC: null, peaksUrl: null };
  assert.equal(canonicalJson(run(C30, C30.seed, "SetLogo", { asset: LOGO.slice(7), meta: dto })), canonicalJson(doc));
  rejects(C30, C30.seed, "SetLogo", { asset: MUSIC, meta: ASSETS[MUSIC] }, "asset_invalid");
  rejects(C30, C30.seed, "SetLogo", { asset: "sha256:xyz", meta: ASSETS[LOGO] }, "asset_invalid");
});

test("a very tall logo is shrunk and moved until its box fits the frame", () => {
  const meta = { kind: "image", mime: "image/png", w: 100, h: 4000 };
  const asset = `sha256:${"c".repeat(64)}`;
  const doc = run(C30, C30.seed, "SetLogo", { asset, meta });
  const t = logoItem(doc).transform;
  const [x0, y0, w, h] = logoBox({ x_e5: t.x_e5, y_e5: t.y_e5, w_e5: t.w_e5, asset_w: 100, asset_h: 4000, out_w: 720, out_h: 1280 });
  assert.ok(x0 >= 0 && y0 >= 0 && x0 + w <= 720 && y0 + h <= 1280);
  assert.ok(t.w_e5 < 16000);
  rejects(C30, C30.seed, "SetLogo", { asset, meta: { kind: "image", mime: "image/png", w: 1, h: 4096 } }, "item_out_of_frame");
});

test("logo transform commands keep the box inside the frame", () => {
  const doc = run(C30, C30.seed, "SetLogo", { asset: LOGO, meta: ASSETS[LOGO] });
  const moved = run(C30, doc, "MoveLogo", { x_e5: 50000, y_e5: 50000 });
  assert.deepEqual(logoItem(moved).transform, { x_e5: 50000, y_e5: 50000, w_e5: 16000, opacity_pm: 850 });
  rejects(C30, doc, "MoveLogo", { x_e5: 100000, y_e5: 50000 }, "item_out_of_frame");
  rejects(C30, doc, "MoveLogo", { x_e5: 100001, y_e5: 50000 }, "value_out_of_range");
  assert.equal(logoItem(run(C30, moved, "ResizeLogo", { w_e5: 40000 })).transform.w_e5, 40000);
  rejects(C30, doc, "ResizeLogo", { w_e5: 40000 }, "item_out_of_frame");
  rejects(C30, doc, "ResizeLogo", { w_e5: 3999 }, "value_out_of_range");
  assert.equal(logoItem(run(C30, doc, "SetLogoOpacity", { opacity_pm: 200 })).transform.opacity_pm, 200);
  rejects(C30, doc, "SetLogoOpacity", { opacity_pm: 1001 }, "value_out_of_range");
  for (const corner of ["top_left", "top_right", "bottom_left", "bottom_right"]) {
    const snapped = run(C30, moved, "SnapLogo", { corner });
    const t = logoItem(snapped).transform;
    const [x0, y0, w, h] = logoBox({ ...t, asset_w: 512, asset_h: 512, out_w: 720, out_h: 1280 });
    assert.equal(x0 < 360, corner.endsWith("left"), corner);
    assert.equal(y0 < 640, corner.startsWith("top"), corner);
    assert.ok(x0 >= 0 && y0 >= 0 && x0 + w <= 720 && y0 + h <= 1280, corner);
  }
  rejects(C30, doc, "SnapLogo", { corner: "center" }, "invalid_args");
  const [x, y] = clampLogoPosition(doc, 100000, 0, C30.ctx);
  assert.deepEqual(checkDoc(run(C30, doc, "MoveLogo", { x_e5: x, y_e5: y }), C30.ctx), []);
  for (const type of ["MoveLogo", "ResizeLogo", "SetLogoOpacity", "SnapLogo"]) {
    rejects(C30, C30.seed, type, { x_e5: 1, y_e5: 1, w_e5: 5000, opacity_pm: 500, corner: "top_left" }, "logo_missing");
  }
});

test("replacing and removing the logo keeps assets exactly the referenced ones", () => {
  const doc = run(C30, C30.seed, "SetLogo", { asset: LOGO, meta: ASSETS[LOGO] });
  const moved = run(C30, doc, "MoveLogo", { x_e5: 50000, y_e5: 50000 });
  const replaced = run(C30, moved, "SetLogo", { asset: LOGO_WIDE, meta: ASSETS[LOGO_WIDE] });
  assert.deepEqual(Object.keys(replaced.assets), [LOGO_WIDE]);
  assert.equal(logoItem(replaced).transform.x_e5, 50000);
  const removed = run(C30, replaced, "RemoveLogo", {});
  assert.equal(contentJson(removed), contentJson(C30.seed));
});

test("SetMusic adds a ducked music bed with the defaults of Appendix B", () => {
  const doc = run(C30, C30.seed, "SetMusic", { asset: MUSIC, meta: ASSETS[MUSIC] });
  assert.deepEqual(doc.tracks.map((track) => track.id), ["tr_hook", "tr_mus"]);
  assert.deepEqual(musicItem(doc).payload, {
    asset: MUSIC, src_in_smp: 0, loop: true, gain_cdb: -980, fade_in_f: 15, fade_out_f: 30,
    duck: { on: true, depth_cdb: 1000, attack_ms: 30, release_ms: 400, hold_ms: 250, detector: "words" },
  });
  assert.deepEqual(doc.assets, { [MUSIC]: ASSETS[MUSIC] });
  assert.equal(defaultMusicGain(-6000), 600);
  assert.equal(defaultMusicGain(3000), -4800);
  assert.deepEqual(DUCK_PRESETS, { halus: 600, sedang: 1000, kuat: 1600 });
  const both = run(C30, run(C30, doc, "SetLogo", { asset: LOGO, meta: ASSETS[LOGO] }), "SetMusic", { asset: MUSIC_SHORT, meta: ASSETS[MUSIC_SHORT] });
  assert.deepEqual(both.tracks.map((track) => track.id), ["tr_hook", "tr_ovr", "tr_mus"]);
  assert.deepEqual(Object.keys(both.assets).sort(), [LOGO, MUSIC_SHORT].sort());
  rejects(C30, C30.seed, "SetMusic", { asset: LOGO, meta: ASSETS[LOGO] }, "asset_invalid");
});

test("music field commands follow §3.3 ranges", () => {
  const doc = run(C30, C30.seed, "SetMusic", { asset: MUSIC, meta: ASSETS[MUSIC] });
  const fadeMax = sfFloor(10000, [30000, 1001]);
  const pay = (d) => musicItem(d).payload;
  assert.equal(pay(run(C30, doc, "SetMusicGain", { gain_cdb: 600 })).gain_cdb, 600);
  rejects(C30, doc, "SetMusicGain", { gain_cdb: -4801 }, "value_out_of_range");
  assert.equal(pay(run(C30, doc, "SetMusicOffset", { src_in_smp: 142000 * 48 - 1 })).src_in_smp, 142000 * 48 - 1);
  rejects(C30, doc, "SetMusicOffset", { src_in_smp: 142000 * 48 }, "value_out_of_range");
  assert.equal(pay(run(C30, doc, "SetMusicLoop", { loop: false })).loop, false);
  rejects(C30, doc, "SetMusicLoop", { loop: "no" }, "invalid_args");
  const faded = pay(run(C30, doc, "SetMusicFades", { fade_in_f: 0, fade_out_f: fadeMax }));
  assert.deepEqual([faded.fade_in_f, faded.fade_out_f], [0, fadeMax]);
  assert.equal(pay(run(C30, doc, "SetMusicFades", { fade_out_f: 5 })).fade_in_f, 15);
  rejects(C30, doc, "SetMusicFades", { fade_in_f: fadeMax + 1 }, "value_out_of_range");
  rejects(C30, doc, "SetMusicFades", {}, "invalid_args");
  assert.equal(pay(run(C30, doc, "SetDuck", { preset: "kuat" })).duck.depth_cdb, 1600);
  assert.equal(pay(run(C30, doc, "SetDuck", { on: false })).duck.on, false);
  const tuned = pay(run(C30, doc, "SetDuck", { attack_ms: 5, release_ms: 2000, hold_ms: 0, depth_cdb: 2400 })).duck;
  assert.deepEqual(tuned, { on: true, depth_cdb: 2400, attack_ms: 5, release_ms: 2000, hold_ms: 0, detector: "words" });
  rejects(C30, doc, "SetDuck", { attack_ms: 4 }, "value_out_of_range");
  rejects(C30, doc, "SetDuck", { preset: "loud" }, "invalid_args");
  assert.equal(contentJson(run(C30, doc, "RemoveMusic", {})), contentJson(C30.seed));
  for (const type of ["SetMusicGain", "SetMusicOffset", "SetMusicLoop", "SetMusicFades", "SetDuck", "RemoveMusic"]) {
    rejects(C30, C30.seed, type, { gain_cdb: 0, src_in_smp: 0, loop: true, fade_in_f: 1, on: true }, "music_missing");
  }
});

test("source gain and loudness", () => {
  assert.equal(run(C30, C30.seed, "SetSourceGain", { gain_cdb: 1200 }).audio.source.gain_cdb, 1200);
  rejects(C30, C30.seed, "SetSourceGain", { gain_cdb: -2401 }, "value_out_of_range");
  const doc = run(C30, C30.seed, "SetLoudness", { mode: "normalize", target_clufs: -900, tp_cdb: -300 });
  assert.deepEqual(doc.audio.master, { mode: "normalize", target_clufs: -900, tp_cdb: -300 });
  assert.equal(run(C30, doc, "SetLoudness", { mode: "off" }).audio.master.target_clufs, -900);
  rejects(C30, C30.seed, "SetLoudness", { mode: "loud" }, "value_out_of_range");
  rejects(C30, C30.seed, "SetLoudness", { mode: "normalize", target_clufs: -800 }, "value_out_of_range");
});

test("ResetToSeed restores the AI version and keeps revision, parent and created_at", () => {
  const inside = wordsIn(C24, body(C24.seed));
  let doc = { ...structuredClone(C24.seed), revision: 5, parent_sha256: "c".repeat(64) };
  doc = run(C24, doc, "RemoveWords", { wordIds: [inside[4].id] });
  doc = run(C24, doc, "SetCaptionPack", { id: "box" });
  doc = run(C24, doc, "SetHookEnabled", { on: false });
  doc = run(C24, doc, "SetLayout", { mode: "camera" });
  const reset = run(C24, doc, "ResetToSeed", {});
  assert.ok(contentEquals(reset, C24.seed));
  assert.equal(reset.revision, 5);
  assert.equal(reset.parent_sha256, "c".repeat(64));
  assert.equal(reset.audit.created_at_ms, C24.seed.audit.created_at_ms);
});
