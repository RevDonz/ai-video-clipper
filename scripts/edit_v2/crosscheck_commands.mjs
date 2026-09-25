#!/usr/bin/env node
// Random command sequences for the editor's client state (plan §10.2 QG-UNDO and QG-CONFLICT,
// §11.2 T2.5). Shared by the node tests (web/tests/editor-{commands,history,rebase}.test.mjs)
// and the Python cross-check (tests/test_edit_v2_crosscheck.py).
//
//   node scripts/edit_v2/crosscheck_commands.mjs docs --sequences 1000 --seed 20260925
//       Streams every intermediate document of N random sequences on the three fixture
//       contexts (after each command, undo and redo; plus two-tab rebase merges and conflict
//       resolutions) as JSON lines: a header {ctx, seq, step, op, pieces, seedEqual} and then
//       the document's canonical bytes. The last line is {"summary": true, ...}.
//   node scripts/edit_v2/crosscheck_commands.mjs undo --sequences 10000 --seed 20260925
//       QG-UNDO: undo-all = initial and redo-all = final (canonical bytes), checked step by
//       step against a model of the history; prints the summary JSON.
//   node scripts/edit_v2/crosscheck_commands.mjs conflict --scenarios 2000 --seed 20260925
//       QG-CONFLICT (unit level): two tabs edit the same clip; both edits survive (merge) or
//       the per-part dialog lists exactly the parts both changed differently.
//
// Everything is deterministic for a seed (mulberry32); nothing touches the network.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { COMMANDS, CommandRejected } from "../../web/lib/editor/commands.mjs";
import {
  PACK_IDS,
  SWATCHES,
  body,
  canonicalJson,
  coldOpen,
  contentJson,
  createContext,
  deepEqual,
  musicItem,
} from "../../web/lib/editor/doc-model.mjs";
import { createEditSession } from "../../web/lib/editor/history.mjs";
import { diffParts, partGroup, partValue, rebase } from "../../web/lib/editor/rebase.mjs";
import { pieces, sfCeil, sfFloor } from "../../web/lib/editor/timemap.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "edit_v2", "docs");
export const CONTEXT_IDS = Object.freeze(["c30", "c25", "c24"]);

/** A fixture context (CONTRACTS §5.11): words artifact, seed, asset store and the command context. */
export function loadContext(id) {
  const index = JSON.parse(readFileSync(path.join(FIXTURES, "index.json"), "utf8"));
  const entry = index.contexts[id];
  if (!entry) throw new Error(`unknown context ${id}`);
  const words = JSON.parse(readFileSync(path.join(FIXTURES, entry.words), "utf8"));
  const seed = JSON.parse(readFileSync(path.join(FIXTURES, entry.seed), "utf8"));
  const assets = JSON.parse(readFileSync(path.join(FIXTURES, index.assets), "utf8"));
  return { id, words, seed, assets, ctx: createContext({ words, seed }) };
}

/** mulberry32: a small deterministic PRNG in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1));
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const chance = (rng, p) => rng() < p;

const WORD_TEXTS = ["Ijal", "  spasi ", "Café", "😂", "x".repeat(40), "x".repeat(41), "", "a\u0007b",
  "Kata-kata", "HALO", "été", "日本語", "a​b", " ", "tab\tdi", "{\\b1}", "\\N", "gua"];
const HOOK_TEXTS = ["Dia ditahan security di film-nya sendiri", "Kenapa sutradara ditahan?", "😂 lucu banget",
  "y".repeat(90), "y".repeat(91), "  spasi di tepi  ", "", "Café kopi", "{\\an8}\\N baris", "Sutradara"];
const REASONS = ["user", "user", "user", "filler", "repeat"];
const CORNERS = ["top_left", "top_right", "bottom_left", "bottom_right"];

function indexesIn(context, segment) {
  if (!segment) return [];
  const { ctx } = context;
  const out = [];
  for (let i = 0; i < ctx.wordList.length; i += 1) {
    const mid = ctx.midSf(i);
    if (mid >= segment.in_sf && mid < segment.out_sf) out.push(i);
  }
  return out;
}

function clampIndex(context, index) {
  return Math.max(0, Math.min(context.ctx.wordList.length - 1, index));
}

function randomGap(rng, doc, context, wide = false) {
  const { ctx } = context;
  const fps = context.seed.output.fps;
  const inside = indexesIn(context, body(doc));
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const i = inside.length ? pick(rng, inside) : int(rng, 0, ctx.wordList.length - 2);
    if (i + 1 >= ctx.wordList.length) continue;
    const lo = sfCeil(ctx.wordList[i].e, fps);
    const hi = sfFloor(ctx.wordList[i + 1].s, fps);
    if (hi - lo < 1) continue;
    const inSf = wide ? lo - int(rng, 0, 2) : int(rng, lo, hi - 1);
    const outSf = wide ? hi + int(rng, 0, 2) : int(rng, inSf + 1, hi);
    return { afterWord: ctx.wordList[i].id, inSf, outSf };
  }
  return { afterWord: ctx.wordList[0].id, inSf: 0, outSf: 1 };
}

function randomRun(rng, doc, context) {
  const co = coldOpen(doc);
  const useCo = co && chance(rng, 0.2);
  const segment = useCo ? co : body(doc);
  let inside = indexesIn(context, segment);
  if (!inside.length || chance(rng, 0.03)) inside = context.ctx.wordList.map((_word, index) => index);
  const start = pick(rng, inside);
  const roll = rng();
  const length = roll < 0.45 ? 1 : roll < 0.85 ? int(rng, 2, 4) : roll < 0.97 ? int(rng, 5, 20) : int(rng, 20, 90);
  const ids = [];
  for (let i = start; i < Math.min(context.ctx.wordList.length, start + length); i += 1) ids.push(context.ctx.wordList[i].id);
  if (chance(rng, 0.04) && ids.length > 2) ids.splice(1, 1);
  const args = { wordIds: ids };
  if (useCo) args.seg = co.id;
  return args;
}

function removalArgs(rng, doc, context) {
  const args = randomRun(rng, doc, context);
  const reason = pick(rng, REASONS);
  if (reason !== "user" || chance(rng, 0.2)) {
    args.reason = reason;
    args.origin = reason === "user" ? "user" : `suggestion:cl_${int(rng, 1, 40)}`;
  }
  return args;
}

function anyWord(rng, doc, context) {
  const inside = indexesIn(context, body(doc));
  const index = inside.length && chance(rng, 0.8) ? pick(rng, inside) : int(rng, 0, context.ctx.wordList.length - 1);
  return context.ctx.wordList[index];
}

function assetsOf(context, kind) {
  return Object.entries(context.assets).filter(([, meta]) => meta.kind === kind).map(([id, meta]) => ({ id, meta }));
}

const GENERATORS = {
  TrimStart(rng, doc, context) {
    const inside = indexesIn(context, body(doc));
    const first = inside.length ? inside[0] : 0;
    return { gapWord: context.ctx.wordList[clampIndex(context, first + int(rng, -25, 25))].id };
  },
  TrimEnd(rng, doc, context) {
    const inside = indexesIn(context, body(doc));
    const last = inside.length ? inside.at(-1) : context.ctx.wordList.length - 1;
    return { gapWord: context.ctx.wordList[clampIndex(context, last + int(rng, -25, 25))].id };
  },
  RemoveWords: removalArgs,
  RemoveGap(rng, doc, context) {
    const args = randomGap(rng, doc, context, chance(rng, 0.05));
    if (chance(rng, 0.5)) args.origin = `suggestion:cl_${int(rng, 1, 40)}`;
    return args;
  },
  RestoreRemoval(rng, doc) {
    const removals = doc.main.removals;
    return { removalId: removals.length && chance(rng, 0.92) ? pick(rng, removals).id : "rm_999" };
  },
  ApplyCleanup(rng, doc, context) {
    const items = [];
    const count = int(rng, 1, 4);
    for (let k = 0; k < count; k += 1) {
      const id = `cl_${int(rng, 1, 60)}`;
      if (chance(rng, 0.4)) items.push({ id, kind: "gap_silent", ...randomGap(rng, doc, context) });
      else items.push({ id, kind: chance(rng, 0.6) ? "filler" : "repeat", wordIds: randomRun(rng, doc, context).wordIds.slice(0, 2) });
    }
    return { items };
  },
  SetColdOpen(rng, doc, context) {
    if (chance(rng, 0.2)) return null;
    const { ctx } = context;
    const inside = indexesIn(context, body(doc));
    const start = inside.length && chance(rng, 0.85) ? pick(rng, inside) : int(rng, 0, ctx.wordList.length - 1);
    const end = clampIndex(context, start + int(rng, 0, 22));
    return { firstWord: ctx.wordList[start].id, lastWord: ctx.wordList[end].id };
  },
  NudgeColdOpen(rng) {
    return { edge: chance(rng, 0.5) ? "in" : "out", words: pick(rng, [-3, -2, -1, -1, 1, 1, 2, 3]) };
  },
  EditWordText(rng, doc, context) {
    const word = anyWord(rng, doc, context);
    return { wordId: word.id, text: chance(rng, 0.2) ? word.t : pick(rng, WORD_TEXTS) };
  },
  SetWordHidden(rng, doc, context) {
    return { wordId: anyWord(rng, doc, context).id, on: chance(rng, 0.6) };
  },
  SetWordEmphasis(rng, doc, context) {
    return { wordId: anyWord(rng, doc, context).id, on: chance(rng, 0.6) };
  },
  SetCaptionsEnabled(rng) {
    return { on: chance(rng, 0.6) };
  },
  SetCaptionPack(rng) {
    return { id: chance(rng, 0.05) ? "neon" : pick(rng, PACK_IDS) };
  },
  SetCaptionOverride(rng) {
    const key = pick(rng, ["y_e5", "size_pm", "case", "highlight", "emphasis"]);
    const value = {
      y_e5: () => int(rng, 19000, 93000),
      size_pm: () => int(rng, 650, 1450),
      case: () => pick(rng, ["asis", "upper", "upper", "lower"]),
      highlight: () => pick(rng, [...SWATCHES, "#123456"]),
      emphasis: () => pick(rng, [...SWATCHES, "#ff5c8a"]),
    }[key]();
    return { key, value };
  },
  SetHookEnabled(rng) {
    const args = { on: chance(rng, 0.6) };
    if (args.on && chance(rng, 0.5)) args.text = pick(rng, HOOK_TEXTS);
    return args;
  },
  SetHookText(rng) {
    const args = { text: pick(rng, HOOK_TEXTS) };
    const origin = pick(rng, [undefined, "user", "suggestion:sg_2", "suggestion:sg_14"]);
    if (origin) args.origin = origin;
    return args;
  },
  SetHookDuration(rng) {
    return { dur_f: int(rng, 10, 960) };
  },
  SetHookY(rng) {
    return { y_e5: int(rng, 5000, 41000) };
  },
  SetLayout(rng) {
    return { mode: pick(rng, ["fit_blur", "camera", "fill_center", "fill_center", "split"]) };
  },
  SetLogo(rng, _doc, context) {
    const asset = pick(rng, assetsOf(context, "image"));
    return { asset: asset.id, meta: asset.meta };
  },
  RemoveLogo() {
    return {};
  },
  MoveLogo(rng) {
    return { x_e5: int(rng, 0, 100000), y_e5: int(rng, 0, 100000) };
  },
  ResizeLogo(rng) {
    return { w_e5: int(rng, 3000, 41000) };
  },
  SetLogoOpacity(rng) {
    return { opacity_pm: int(rng, 150, 1050) };
  },
  SnapLogo(rng) {
    return { corner: pick(rng, CORNERS) };
  },
  SetMusic(rng, _doc, context) {
    const asset = pick(rng, assetsOf(context, "audio"));
    return { asset: asset.id, meta: asset.meta };
  },
  RemoveMusic() {
    return {};
  },
  SetMusicGain(rng) {
    return { gain_cdb: int(rng, -5000, 700) };
  },
  SetMusicOffset(rng, doc, context) {
    const item = musicItem(doc);
    const meta = item ? context.assets[item.payload.asset] : null;
    const limit = meta ? meta.duration_ms * 48 : 1_000_000;
    return { src_in_smp: chance(rng, 0.05) ? limit : int(rng, 0, limit - 1) };
  },
  SetMusicLoop(rng) {
    return { loop: chance(rng, 0.5) };
  },
  SetMusicFades(rng) {
    const args = {};
    if (chance(rng, 0.7)) args.fade_in_f = int(rng, 0, 320);
    if (chance(rng, 0.7)) args.fade_out_f = int(rng, 0, 320);
    return args;
  },
  SetDuck(rng) {
    if (chance(rng, 0.3)) return { preset: pick(rng, ["halus", "sedang", "kuat"]) };
    const args = {};
    if (chance(rng, 0.4)) args.on = chance(rng, 0.7);
    if (chance(rng, 0.4)) args.depth_cdb = int(rng, 250, 2500);
    if (chance(rng, 0.3)) args.attack_ms = int(rng, 1, 520);
    if (chance(rng, 0.3)) args.release_ms = int(rng, 40, 2100);
    if (chance(rng, 0.3)) args.hold_ms = int(rng, 0, 1050);
    return args;
  },
  SetSourceGain(rng) {
    return { gain_cdb: int(rng, -2500, 1300) };
  },
  SetLoudness(rng) {
    const args = { mode: pick(rng, ["off", "normalize", "normalize"]) };
    if (chance(rng, 0.4)) args.target_clufs = int(rng, -2500, -800);
    if (chance(rng, 0.3)) args.tp_cdb = int(rng, -350, 50);
    return args;
  },
  ResetToSeed() {
    return {};
  },
};

const WEIGHTS = {
  RemoveWords: 16, RestoreRemoval: 5, TrimStart: 5, TrimEnd: 5, RemoveGap: 4, ApplyCleanup: 3, SetColdOpen: 4,
  NudgeColdOpen: 4, EditWordText: 7, SetWordHidden: 3, SetWordEmphasis: 3, SetCaptionsEnabled: 1, SetCaptionPack: 2,
  SetCaptionOverride: 4, SetHookEnabled: 2, SetHookText: 4, SetHookDuration: 2, SetHookY: 2, SetLayout: 2, SetLogo: 3,
  RemoveLogo: 1, MoveLogo: 3, ResizeLogo: 2, SetLogoOpacity: 2, SnapLogo: 2, SetMusic: 3, RemoveMusic: 1,
  SetMusicGain: 2, SetMusicOffset: 2, SetMusicLoop: 1, SetMusicFades: 2, SetDuck: 2, SetSourceGain: 2, SetLoudness: 2,
  ResetToSeed: 1,
};
const TOTAL_WEIGHT = Object.values(WEIGHTS).reduce((sum, weight) => sum + weight, 0);

/** One random command for `doc`: mostly valid arguments, some out of range on purpose. */
export function randomCommand(rng, doc, context) {
  let roll = rng() * TOTAL_WEIGHT;
  let type = COMMANDS[0];
  for (const name of COMMANDS) {
    roll -= WEIGHTS[name];
    if (roll < 0) {
      type = name;
      break;
    }
  }
  const args = GENERATORS[type](rng, doc, context);
  const merge = rng();
  const options = merge < 0.85 ? {} : merge < 0.93 ? { mergeKey: null } : { mergeKey: "test:burst" };
  return { type, args, options };
}

function advance(rng, clock) {
  clock.t += chance(rng, 0.35) ? int(rng, 0, 450) : int(rng, 501, 3000);
}

/**
 * Runs one random session. `onState(op, doc, step)` sees every document change (op "command",
 * "undo" or "redo"). Returns the session and the model check result.
 */
export function runSession({ rng, context, length, clock = { t: 1_000_000 }, onState = null, stats = null, doc = null }) {
  const session = createEditSession({ doc: doc ?? context.seed, ctx: context.ctx, now: () => clock.t });
  // Model of the history: canonical documents along the current branch.
  const timeline = [canonicalJson(session.doc)];
  let position = 0;
  let mismatches = 0;
  const compare = () => {
    if (canonicalJson(session.doc) !== timeline[position]) mismatches += 1;
  };
  for (let step = 0; step < length; step += 1) {
    advance(rng, clock);
    const roll = rng();
    if (roll < 0.08) {
      if (session.undo()) {
        position -= 1;
        compare();
        if (stats) stats.undos += 1;
        onState?.("undo", session.doc, step);
      }
      continue;
    }
    if (roll < 0.12) {
      if (session.redo()) {
        position += 1;
        compare();
        if (stats) stats.redos += 1;
        onState?.("redo", session.doc, step);
      }
      continue;
    }
    const command = randomCommand(rng, session.doc, context);
    let result;
    try {
      result = session.dispatch(command.type, command.args, command.options);
    } catch (error) {
      if (!(error instanceof CommandRejected)) throw error;
      if (stats) stats.rejectedByCode[error.code] = (stats.rejectedByCode[error.code] ?? 0) + 1;
      if (stats) stats.rejected += 1;
      continue;
    }
    if (!result.changed) {
      if (stats) stats.noop += 1;
      continue;
    }
    if (stats) {
      stats.applied += 1;
      stats.appliedByType[command.type] = (stats.appliedByType[command.type] ?? 0) + 1;
      if (result.merged) stats.merged += 1;
    }
    const canonical = canonicalJson(session.doc);
    if (result.merged) timeline[position] = canonical;
    else {
      timeline.length = position + 1;
      timeline.push(canonical);
      position += 1;
    }
    onState?.("command", session.doc, step);
  }
  return { session, timeline, position, mismatches };
}

function newStats() {
  return { applied: 0, rejected: 0, noop: 0, merged: 0, undos: 0, redos: 0, appliedByType: {}, rejectedByCode: {} };
}

/** QG-UNDO over `sequences` random sessions (plan §10.2). */
export function runUndoProperty({ contexts, sequences, seed, maxLength = 40 }) {
  const stats = newStats();
  let undoMismatches = 0;
  let redoMismatches = 0;
  let stepMismatches = 0;
  let maxEntries = 0;
  const started = performance.now();
  for (let s = 0; s < sequences; s += 1) {
    const rng = mulberry32((seed + Math.imul(s, 0x9e3779b1)) >>> 0);
    const context = contexts[s % contexts.length];
    const length = 1 + Math.floor(rng() * maxLength);
    const { session, timeline, mismatches } = runSession({ rng, context, length, stats });
    stepMismatches += mismatches;
    maxEntries = Math.max(maxEntries, session.history.size);
    const final = canonicalJson(session.doc);
    while (session.undo()) { /* undo everything */ }
    if (canonicalJson(session.doc) !== timeline[0]) undoMismatches += 1;
    while (session.redo()) { /* redo everything */ }
    if (canonicalJson(session.doc) !== final) redoMismatches += 1;
  }
  return {
    gate: "QG-UNDO", sequences, seed, contexts: contexts.map((context) => context.id), maxLength,
    undoMismatches, redoMismatches, stepMismatches, maxEntries, ...stats,
    commandTypes: [...COMMANDS], seconds: Math.round(performance.now() - started) / 1000,
  };
}

/**
 * Two tabs edit the same clip from `base`: returns their sessions after `mineSteps` and
 * `theirsSteps` random commands (the first tab's pending log is what a 409 rebases).
 */
export function randomTwoTabs(rng, context, { base = context.seed, mineSteps = 6, theirsSteps = 6 } = {}) {
  const clock = { t: 5_000_000 };
  const mine = runSession({ rng, context, length: mineSteps, clock, doc: base }).session;
  const theirs = runSession({ rng, context, length: theirsSteps, clock, doc: base }).session;
  return { base, mine, theirs };
}

/**
 * QG-CONFLICT property for one scenario: merged → every part changed by only one tab keeps
 * that tab's value; conflict → the dialog lists only parts both tabs changed or whose replay
 * failed, and resolving every group with "mine" or "theirs" gives a valid document.
 */
export function checkConflictScenario({ base, mine, theirs, context, rng }) {
  const steps = mine.pending;
  const result = rebase({ base, mine: mine.doc, theirs: theirs.doc, steps, ctx: context.ctx });
  const mineParts = new Set(diffParts(base, mine.doc));
  const theirsParts = new Set(diffParts(base, theirs.doc));
  const problems = [];
  const docs = [];
  if (result.status === "merged") {
    docs.push(["rebase", result.doc]);
    for (const part of theirsParts) {
      if (!mineParts.has(part) && !deepEqual(partValue(result.doc, part), partValue(theirs.doc, part))
        && !part.startsWith("removals:")) problems.push(`theirs lost ${part}`);
    }
    for (const part of mineParts) {
      if (!theirsParts.has(part) && !deepEqual(partValue(result.doc, part), partValue(mine.doc, part))
        && !part.startsWith("removals:")) {
        problems.push(`mine lost ${part}`);
      }
    }
  } else {
    docs.push(["rebase", result.doc]);
    for (const group of result.conflicts) {
      if (!group.label) problems.push(`group ${group.id} has no label`);
      for (const part of group.parts) {
        if (partGroup(part) !== group.id) problems.push(`part ${part} outside group ${group.id}`);
      }
    }
    for (const choice of ["mine", "theirs", "random"]) {
      const choices = Object.fromEntries(result.conflicts.map((group) => [group.id,
        choice === "random" ? (chance(rng, 0.5) ? "mine" : "theirs") : choice]));
      try {
        const resolved = result.resolve(choices);
        docs.push(["resolve", resolved.doc]);
        if (choice === "theirs" && result.conflicts.length && !resolved.doc) problems.push("no document");
      } catch (error) {
        if (!(error instanceof CommandRejected)) throw error;
        if (choice === "theirs") problems.push(`"theirs" everywhere was rejected: ${error.code}`);
      }
    }
  }
  return { result, problems, docs };
}

/** QG-CONFLICT (unit level) over `scenarios` random two-tab edits. */
export function runConflictProperty({ contexts, scenarios, seed }) {
  const summary = { gate: "QG-CONFLICT", level: "unit", scenarios, seed, merged: 0, conflicts: 0, groups: {},
    problems: 0, examples: [], resolvedDocs: 0 };
  const started = performance.now();
  for (let s = 0; s < scenarios; s += 1) {
    const rng = mulberry32((seed + Math.imul(s, 0x85ebca6b)) >>> 0);
    const context = contexts[s % contexts.length];
    const scenario = randomTwoTabs(rng, context, { mineSteps: int(rng, 1, 8), theirsSteps: int(rng, 1, 8) });
    const { result, problems, docs } = checkConflictScenario({ ...scenario, context, rng });
    if (result.status === "merged") summary.merged += 1;
    else {
      summary.conflicts += 1;
      for (const group of result.conflicts) {
        const kind = group.id.split(":")[0];
        summary.groups[kind] = (summary.groups[kind] ?? 0) + 1;
      }
    }
    summary.resolvedDocs += docs.filter(([op]) => op === "resolve").length;
    summary.problems += problems.length;
    if (problems.length && summary.examples.length < 5) summary.examples.push({ scenario: s, problems });
  }
  summary.seconds = Math.round(performance.now() - started) / 1000;
  return summary;
}

function header(context, seq, step, op, doc) {
  const list = pieces(doc).map((piece) => [piece.seg, piece.inSf, piece.outSf, piece.outF0, piece.frames]);
  return JSON.stringify({ ctx: context.id, seq, step, op, pieces: list, seedEqual: contentJson(doc) === contentJson(context.seed) });
}

/** Streams every intermediate document for the Python cross-check (see the header comment). */
export function generateDocs({ contexts, sequences, seed, write }) {
  const stats = newStats();
  let emitted = 0;
  let rebases = 0;
  const emit = (context, seq, step, op, doc) => {
    write(`${header(context, seq, step, op, doc)}\n${canonicalJson(doc)}\n`);
    emitted += 1;
  };
  for (let s = 0; s < sequences; s += 1) {
    const rng = mulberry32((seed + Math.imul(s, 0x27d4eb2f)) >>> 0);
    const context = contexts[s % contexts.length];
    const length = 1 + Math.floor(rng() * 30);
    const { session } = runSession({ rng, context, length, stats,
      onState: (op, doc, step) => emit(context, s, step, op, doc) });
    if (s % 2 === 0) {
      const scenario = randomTwoTabs(rng, context, { base: session.doc, mineSteps: int(rng, 1, 6), theirsSteps: int(rng, 1, 6) });
      const { docs } = checkConflictScenario({ ...scenario, context, rng });
      for (const [op, doc] of docs) emit(context, s, length, op, doc);
      rebases += 1;
    }
  }
  write(`${JSON.stringify({ summary: true, sequences, seed, emitted, rebases, ...stats })}\n`);
}

function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = { mode, sequences: 1000, scenarios: 2000, seed: 20260925, evidence: null };
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i].replace(/^--/, "");
    const value = rest[i + 1];
    if (key === "evidence") options.evidence = value;
    else options[key] = Number.parseInt(value, 10);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  const contexts = CONTEXT_IDS.map(loadContext);
  if (options.mode === "docs") {
    let buffer = "";
    const write = (text) => {
      buffer += text;
      if (buffer.length > 1 << 16) {
        process.stdout.write(buffer);
        buffer = "";
      }
    };
    generateDocs({ contexts, sequences: options.sequences, seed: options.seed, write });
    process.stdout.write(buffer);
    return 0;
  }
  let summary;
  if (options.mode === "undo") summary = runUndoProperty({ contexts, sequences: options.sequences, seed: options.seed });
  else if (options.mode === "conflict") summary = runConflictProperty({ contexts, scenarios: options.scenarios, seed: options.seed });
  else {
    process.stderr.write("usage: crosscheck_commands.mjs docs|undo|conflict [--sequences N] [--scenarios N] [--seed S] [--evidence FILE]\n");
    return 2;
  }
  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (options.evidence) writeFileSync(options.evidence, text);
  process.stdout.write(text);
  const failed = options.mode === "undo" ? summary.undoMismatches + summary.redoMismatches + summary.stepMismatches : summary.problems;
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
