// The Transisi section of the Cold open panel (docs/plans/2026-10-02-transisi-cold-open.md §7.1):
// its view model (panels/coldopen-transition.mjs) and the fakes' plan DTO `joins`, a dev-only port
// of §1.6 and §2.1 that the editor e2e runs on.
import assert from "node:assert/strict";
import test from "node:test";

import { loadContext } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import { fakeAlphaPm, fakeDoc, fakeJoins, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  TRANSITION_NOTE,
  TRANSITION_REASONS,
  TRANSITION_STYLES,
  sfxStatus,
  styleStatus,
  transitionCommands,
  transitionStatus,
  transitionView,
} from "../components/editor/panels/coldopen-transition.mjs";
import { applyCommand } from "../lib/editor/commands.mjs";
import { body, coldOpen, createContext } from "../lib/editor/doc-model.mjs";
import { pieces, totalFrames } from "../lib/editor/timemap.mjs";

const C30 = loadContext("c30");
const C25 = loadContext("c25");
const WHOOSH = Object.freeze({ id: "whoosh", v: 1 });

const apply = (context, doc, commands) => commands.reduce((current, { type, args }) => applyCommand(current, type, args, context.ctx).doc, doc);

function wordsIn(context, segment) {
  return context.ctx.wordList.filter((_word, index) => {
    const mid = context.ctx.midSf(index);
    return mid >= segment.in_sf && mid < segment.out_sf;
  });
}

test("the three choices, their lengths and the copy", () => {
  assert.deepEqual(TRANSITION_STYLES.map((option) => [option.id, option.name, option.detail]), [
    ["cut", "Potong langsung", "Tanpa efek"],
    ["flash_white", "Kilat putih", "0,2 dtk"],
    ["dip_black", "Gelap sebentar", "0,3 dtk"],
  ]);
  assert.equal(TRANSITION_NOTE, "Efek di sambungan cold open ke awal klip. Durasi klip tetap.");
  assert.deepEqual(TRANSITION_REASONS, { coldOpenOff: "Aktifkan cold open dulu.", readOnly: "Klip ini sedang dalam mode baca-saja" });
  for (const text of [TRANSITION_NOTE, ...Object.values(TRANSITION_REASONS), ...TRANSITION_STYLES.flatMap((o) => [o.name, o.detail])]) {
    assert.ok(!text.includes("—"), text);
  }
});

test("transitionView: a cold open with its join, and the join frame J = the cold open's piece frames", () => {
  const co = coldOpen(C30.seed);
  const view = transitionView(C30.seed);
  assert.deepEqual(view, {
    enabled: true, reason: null, style: "cut", sfxOn: false, joinFrame: co.out_sf - co.in_sf,
    audition: { f0: co.out_sf - co.in_sf - 30, f1: co.out_sf - co.in_sf + 30 },
  });
  const styled = apply(C30, C30.seed, [transitionCommands.style("dip_black"), transitionCommands.sfx(true)]);
  assert.deepEqual([transitionView(styled).style, transitionView(styled).sfxOn], ["dip_black", true]);
  // A cut inside the cold open moves the join earlier by the frames it removes.
  const coWords = wordsIn(C30, co);
  const cut = applyCommand(C30.seed, "RemoveWords", { wordIds: [coWords[1].id], seg: co.id }, C30.ctx).doc;
  const coFrames = pieces(cut).filter((piece) => piece.seg === co.id).reduce((sum, piece) => sum + piece.frames, 0);
  assert.ok(coFrames < co.out_sf - co.in_sf);
  assert.equal(transitionView(cut).joinFrame, coFrames);
  // Read-only shows the transition and says why it cannot change.
  assert.deepEqual(transitionView(styled, { readOnly: true }), {
    ...transitionView(styled), enabled: false, reason: "Klip ini sedang dalam mode baca-saja",
  });
});

test("transitionView: without a cold open the section is disabled and says what to do", () => {
  assert.deepEqual(transitionView(C25.seed), {
    enabled: false, reason: "Aktifkan cold open dulu.", style: null, sfxOn: false, joinFrame: null, audition: null,
  });
  assert.equal(transitionView(C25.seed, { readOnly: true }).reason, "Klip ini sedang dalam mode baca-saja");
  assert.equal(transitionView(null).enabled, false);
});

test("Putar transisi plays one second on each side of the join, inside the clip", () => {
  // c25 (25 fps): a cold open of under a second starts the audition at frame 0.
  const seg = body(C25.seed);
  const words = wordsIn(C25, seg);
  let doc = null;
  for (let i = 40; i < words.length && !doc; i += 1) {
    try {
      doc = applyCommand(C25.seed, "SetColdOpen", { firstWord: words[i].id, lastWord: words[i].id }, C25.ctx).doc;
    } catch {
      doc = null;
    }
  }
  assert.ok(doc, "a one-word cold open");
  const view = transitionView(doc);
  assert.ok(view.joinFrame < 25, `J = ${view.joinFrame}`);
  assert.deepEqual(view.audition, { f0: 0, f1: view.joinFrame + 25 });
  assert.ok(view.audition.f1 <= totalFrames(pieces(doc)));
});

test("commands and status lines", () => {
  assert.deepEqual(transitionCommands.style("flash_white"), { type: "SetJoinStyle", args: { style: "flash_white" }, mergeKey: null });
  assert.deepEqual(transitionCommands.sfx(false), { type: "SetJoinSfx", args: { on: false }, mergeKey: null });
  assert.equal(styleStatus("flash_white"), "Transisi: Kilat putih.");
  assert.equal(styleStatus("cut"), "Transisi: Potong langsung.");
  assert.equal(styleStatus("dip_black"), "Transisi: Gelap sebentar.");
  assert.equal(sfxStatus(true), "Whoosh aktif.");
  assert.equal(sfxStatus(false), "Whoosh mati.");
  // The line describes the last choice only while the document still shows it (an undo clears it).
  const flash = transitionView(apply(C30, C30.seed, [transitionCommands.style("flash_white")]));
  assert.equal(transitionStatus({ kind: "style", value: "flash_white" }, flash), "Transisi: Kilat putih.");
  assert.equal(transitionStatus({ kind: "style", value: "dip_black" }, flash), "");
  assert.equal(transitionStatus({ kind: "sfx", value: false }, flash), "Whoosh mati.");
  assert.equal(transitionStatus({ kind: "sfx", value: true }, flash), "");
  assert.equal(transitionStatus(null, flash), "");
  assert.equal(transitionStatus({ kind: "style", value: "cut" }, transitionView(C25.seed)), "");
});

// --- the fakes' plan DTO `joins` (§1.6, §2.2) ----------------------------------------------------

const TABLE = [
  ["flash_white", [24, 1], 2, [167, 583, 1000, 583, 167]],
  ["flash_white", [25, 1], 2, [200, 600, 1000, 600, 200]],
  ["flash_white", [30, 1], 2, [333, 667, 1000, 667, 333]],
  ["flash_white", [24000, 1001], 2, [166, 583, 1000, 583, 166]],
  ["flash_white", [30000, 1001], 2, [333, 666, 1000, 666, 333]],
  ["dip_black", [24, 1], 3, [167, 444, 722, 1000, 722, 444, 167]],
  ["dip_black", [25, 1], 3, [200, 467, 733, 1000, 733, 467, 200]],
  ["dip_black", [30, 1], 4, [111, 333, 556, 778, 1000, 778, 556, 333, 111]],
  ["dip_black", [24000, 1001], 3, [166, 444, 722, 1000, 722, 444, 166]],
  ["dip_black", [30000, 1001], 4, [110, 333, 555, 778, 1000, 778, 555, 333, 110]],
];

test("fakeAlphaPm reproduces the §2.2 table at every supported rate", () => {
  for (const [style, fps, before, values] of TABLE) {
    const got = [];
    for (let k = -before - 2; k < values.length - before + 2; k += 1) got.push(fakeAlphaPm(style, k, fps));
    assert.deepEqual(got, [0, 0, ...values, 0, 0], `${style} ${fps.join("/")}`);
  }
  for (const k of [-3, 0, 3]) assert.equal(fakeAlphaPm("cut", k, [30000, 1001]), 0);
});

test("fakeJoins gives the §1.6 DTO: J, colour, alphas inside the clip and the whoosh placement", () => {
  const doc = (style, sfx) => ({ main: { joins: [{ after: "seg_co", style, audio_fade_ms: 30, ...(sfx ? { sfx: { ...WHOOSH } } : {}) }] } });
  const list = [{ seg: "seg_co", frames: 60 }, { seg: "seg_b1", frames: 240 }];
  assert.deepEqual(fakeJoins(doc("flash_white", true), list, 300), [{
    after: "seg_co", style: "flash_white", atF: 60, rgb: [255, 255, 255],
    alphaPm: [[58, 333], [59, 666], [60, 1000], [61, 666], [62, 333]],
    sfx: { id: "whoosh", v: 1, startSmp: 84576, hitSmp: 96096, samples: 20160 },
  }]);
  const dip = fakeJoins(doc("dip_black", false), list, 300)[0];
  assert.deepEqual([dip.rgb, dip.alphaPm.length, dip.alphaPm[0], dip.sfx], [[0, 0, 0], 9, [56, 110], null]);
  assert.deepEqual(fakeJoins(doc("cut", true), list, 300)[0],
    { after: "seg_co", style: "cut", atF: 60, rgb: null, alphaPm: [], sfx: { id: "whoosh", v: 1, startSmp: 84576, hitSmp: 96096, samples: 20160 } });
  // Frames outside the clip are dropped, never rescaled; a whoosh before sample 0 loses its head.
  const short = fakeJoins(doc("flash_white", true), [{ seg: "seg_co", frames: 1 }, { seg: "seg_b1", frames: 2 }], 3)[0];
  assert.deepEqual(short.alphaPm, [[0, 666], [1, 1000], [2, 666]]);
  assert.deepEqual(short.sfx, { id: "whoosh", v: 1, startSmp: 0, hitSmp: 1601, samples: 20160 - (11520 - 1601) });
  assert.deepEqual(fakeJoins({ main: { joins: [] } }, list, 300), []);
});

test("fakePlan carries `joins`: [] without a cold open, the join with one", () => {
  assert.deepEqual(fakePlan(fakeDoc()).joins, []);
  const ctx = createContext({ words: fakeWords(), seed: fakeDoc() });
  const doc = applyCommand(fakeDoc(), "SetColdOpen", { firstWord: "w048127", lastWord: "w048132" }, ctx).doc;
  const plan = fakePlan(doc);
  const co = coldOpen(doc);
  assert.equal(plan.joins.length, 1);
  assert.deepEqual([plan.joins[0].style, plan.joins[0].atF, plan.joins[0].sfx?.id], ["flash_white", co.out_sf - co.in_sf, "whoosh"]);
  assert.equal(plan.joins[0].atF, transitionView(doc).joinFrame);
});
