// History and the edit session (web/lib/editor/history.mjs, plan §4.5): 200 steps, mergeKey
// merging within 500 ms, undo/redo, and the pending command log that autosave, the draft and
// rebase replay. QG-UNDO (plan §10.2): 10,000 random command sequences, undo-all equals the
// initial document and redo-all the final one (canonical bytes).
import assert from "node:assert/strict";
import test from "node:test";

import { loadContext, mulberry32, randomCommand, runUndoProperty } from "../../scripts/edit_v2/crosscheck_commands.mjs";
import { CommandRejected } from "../lib/editor/commands.mjs";
import { body, canonicalJson, contentJson } from "../lib/editor/doc-model.mjs";
import { HISTORY_LIMIT, MERGE_WINDOW_MS, createEditSession, createHistory } from "../lib/editor/history.mjs";
import { replaySteps } from "../lib/editor/rebase.mjs";

const C30 = loadContext("c30");

function entry(at, mergeKey = null, tag = at) {
  return { type: "SetHookY", args: { y_e5: tag }, mergeKey, at, before: { v: tag - 1 }, after: { v: tag }, parts: ["hook.y"] };
}

test("history limits, undo and redo", () => {
  assert.equal(HISTORY_LIMIT, 200);
  assert.equal(MERGE_WINDOW_MS, 500);
  const history = createHistory();
  assert.equal(history.canUndo, false);
  for (let i = 1; i <= 205; i += 1) history.record(entry(i * 1000));
  assert.equal(history.size, 200);
  assert.deepEqual(history.undo().before, { v: 204999 });
  assert.equal(history.canRedo, true);
  assert.deepEqual(history.redo().after, { v: 205000 });
  let undone = 0;
  while (history.undo()) undone += 1;
  assert.equal(undone, 200);
  assert.equal(history.canUndo, false);
  history.redo();
  history.record(entry(999999));
  assert.equal(history.canRedo, false, "a new command clears the redo branch");
  assert.equal(history.size, 2);
});

test("commands with the same mergeKey within 500 ms become one entry", () => {
  const history = createHistory();
  history.record(entry(1000, "hook:y", 1));
  assert.equal(history.record(entry(1400, "hook:y", 2)).merged, true);
  assert.equal(history.record(entry(1900, "hook:y", 3)).merged, true, "the window slides with each merge");
  assert.equal(history.record(entry(2401, "hook:y", 4)).merged, false);
  assert.equal(history.record(entry(2500, "cap:y_e5", 5)).merged, false);
  assert.equal(history.record(entry(2600, null, 6)).merged, false);
  assert.equal(history.record(entry(2700, null, 7)).merged, false, "null never merges");
  assert.equal(history.size, 5);
  const first = history.entries[0];
  assert.deepEqual([first.before, first.after, first.steps.length], [{ v: 0 }, { v: 3 }, 3]);
  history.seal();
  assert.equal(history.record(entry(2800, null, 8)).merged, false);
  history.record(entry(3000, "hook:y", 9));
  history.seal();
  assert.equal(history.record(entry(3100, "hook:y", 10)).merged, false, "a sealed entry never grows");
  history.undo();
  assert.equal(history.record(entry(3200, "hook:y", 11)).merged, false, "no merging into an undone entry");
});

function wordIn(context, n) {
  const seg = body(context.seed);
  return context.ctx.wordList.filter((_word, index) => {
    const mid = context.ctx.midSf(index);
    return mid >= seg.in_sf && mid < seg.out_sf;
  })[n];
}

test("the session applies commands, ignores no-ops and leaves the document alone on rejection", () => {
  let t = 0;
  const session = createEditSession({ doc: C30.seed, ctx: C30.ctx, now: () => t });
  const result = session.dispatch("SetLayout", { mode: "camera" });
  assert.equal(result.changed, true);
  assert.equal(session.doc.layout.default.mode, "camera");
  t += 1000;
  assert.equal(session.dispatch("SetLayout", { mode: "camera" }).changed, false);
  assert.equal(session.history.size, 1);
  const before = session.doc;
  assert.throws(() => session.dispatch("SetHookY", { y_e5: 1 }), CommandRejected);
  assert.equal(session.doc, before);
  assert.equal(session.pending.length, 1);
  assert.deepEqual(session.pending[0].parts, ["layout"]);
});

test("typing in one word is one undo step", () => {
  let t = 0;
  const session = createEditSession({ doc: C30.seed, ctx: C30.ctx, now: () => t });
  const word = wordIn(C30, 3);
  for (const text of ["I", "Ij", "Ija", "Ijal"]) {
    t += 120;
    session.dispatch("EditWordText", { wordId: word.id, text });
  }
  assert.equal(session.history.size, 1);
  assert.equal(session.pending.length, 4);
  session.undo();
  assert.equal(contentJson(session.doc), contentJson(C30.seed));
  assert.equal(session.pending.length, 0, "undoing unsaved steps pops them from the log");
  session.redo();
  assert.equal(session.doc.captions.word_edits[word.id].text, "Ijal");
  assert.equal(session.pending.length, 4);
});

test("the pending log always replays the base into the current document", () => {
  let t = 0;
  const session = createEditSession({ doc: C30.seed, ctx: C30.ctx, now: () => t });
  let base = C30.seed;
  const rng = mulberry32(99);
  for (let i = 0; i < 400; i += 1) {
    t += rng() < 0.3 ? 100 : 900;
    const roll = rng();
    if (roll < 0.12) session.undo();
    else if (roll < 0.2) session.redo();
    else if (roll < 0.27) {
      // A save: the base becomes the current document, the log restarts after it.
      session.seal();
      base = session.doc;
      session.saved(session.pending.length);
    } else {
      const command = randomCommand(rng, session.doc, C30);
      try {
        session.dispatch(command.type, command.args, command.options);
      } catch (error) {
        if (!(error instanceof CommandRejected)) throw error;
      }
    }
    const replayed = replaySteps(base, session.pending, C30.ctx).doc;
    assert.equal(contentJson(replayed), contentJson(session.doc), `step ${i}`);
  }
});

test("undo past a save is logged as a part restore; redo pops it", () => {
  let t = 0;
  const session = createEditSession({ doc: C30.seed, ctx: C30.ctx, now: () => t });
  session.dispatch("SetLayout", { mode: "camera" });
  session.seal();
  const saved = session.doc;
  session.saved(session.pending.length);
  assert.equal(session.pending.length, 0);
  session.undo();
  assert.equal(session.pending.length, 1);
  assert.equal(session.pending[0].type, "__parts");
  assert.deepEqual(session.pending[0].values, { layout: C30.seed.layout.default });
  assert.equal(contentJson(replaySteps(saved, session.pending, C30.ctx).doc), contentJson(C30.seed));
  session.redo();
  assert.equal(session.pending.length, 0);
  assert.equal(canonicalJson(session.doc), canonicalJson(saved));
});

test("QG-UNDO: 10,000 random sequences, undo-all = initial and redo-all = final", () => {
  const contexts = [loadContext("c30"), loadContext("c25"), loadContext("c24")];
  const summary = runUndoProperty({ contexts, sequences: 10000, seed: 20260925 });
  assert.equal(summary.sequences, 10000);
  assert.equal(summary.undoMismatches, 0);
  assert.equal(summary.redoMismatches, 0);
  assert.ok(summary.applied > 50000, `only ${summary.applied} commands applied`);
  assert.ok(summary.merged > 1000, `only ${summary.merged} merges`);
  for (const type of summary.commandTypes) assert.ok(summary.appliedByType[type] > 0, `${type} never applied`);
});
