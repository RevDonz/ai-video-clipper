#!/usr/bin/env node
// The cold-open transition across the editor client, the engine and the player (spec
// docs/plans/2026-10-02-transisi-cold-open.md §9 "Cross-task shapes"). Driven by
// tests/test_edit_v2_transition_wiring.py, which runs the Python side in between:
//
//   node scripts/edit_v2/transition_wiring.mjs docs
//       For each fixture context: a cold open (the seed's, or one SetColdOpen adds), then every
//       style × whoosh through the real SetJoinStyle/SetJoinSfx commands. Prints JSON lines: a
//       header {ctx, name, style, sfx, joinFrame, totalFrames, fakeJoins} and the document's
//       canonical bytes. joinFrame is the Cold open panel's J; fakeJoins the dev fakes' DTO port.
//   node scripts/edit_v2/transition_wiring.mjs check <file>
//       <file>: [{name, totalFrames, joins}] with the engine's plan DTO joins. Prints, per
//       entry, the player's verdict (joinsValid) and the fills it would draw ([frame, rgb, alpha]).
//   node scripts/edit_v2/transition_wiring.mjs seeds <file>
//       <file>: [{name, ctx, seed}] with seeds whose join the pipeline wrote. Prints, per entry,
//       checkDoc's issues and joinTemplate(seed, seed) (what SetColdOpen gives back).
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { joinOverlays, joinsValid } from "../../web/lib/editor/player/join-layer.mjs";
import { CommandRejected, applyCommand } from "../../web/lib/editor/commands.mjs";
import { JOIN_STYLES, canonicalJson, checkDoc, coldOpen, createContext, joinTemplate } from "../../web/lib/editor/doc-model.mjs";
import { pieces, totalFrames } from "../../web/lib/editor/timemap.mjs";
import { transitionView } from "../../web/components/editor/panels/coldopen-transition.mjs";
import { fakeJoins } from "../../web/components/editor/__dev__/fakes.mjs";
import { CONTEXT_IDS, loadContext } from "./crosscheck_commands.mjs";

/** The first word range SetColdOpen accepts, scanning from a quarter into the words. */
function addColdOpen(doc, context) {
  const words = context.ctx.wordList;
  const start = Math.floor(words.length / 4);
  for (let first = start; first < words.length; first += 1) {
    for (let last = first + 2; last < Math.min(words.length, first + 20); last += 1) {
      try {
        return applyCommand(doc, "SetColdOpen", { firstWord: words[first].id, lastWord: words[last].id }, context.ctx).doc;
      } catch (error) {
        if (!(error instanceof CommandRejected)) throw error;
      }
    }
  }
  throw new Error(`no cold open fits ${context.id}`);
}

function emit(context, name, doc) {
  const list = pieces(doc);
  const total = totalFrames(list);
  const join = doc.main.joins[0];
  const header = {
    ctx: context.id, name, style: join.style, sfx: Boolean(join.sfx), joinFrame: transitionView(doc).joinFrame,
    totalFrames: total, fakeJoins: fakeJoins(doc, list, total, doc.output.fps),
  };
  process.stdout.write(`${JSON.stringify(header)}\n${canonicalJson(doc)}\n`);
}

function docs() {
  for (const id of CONTEXT_IDS) {
    const context = loadContext(id);
    const seed = context.seed;
    let base = seed;
    if (coldOpen(seed)) {
      // removing and re-adding the seed's cold open keeps the seed's join (§7.2)
      const removed = applyCommand(seed, "SetColdOpen", null, context.ctx).doc;
      emit(context, "readded", addColdOpen(removed, context));
    } else {
      base = addColdOpen(seed, context); // no seed join: the auto clips' default (§7.2)
      emit(context, "added", base);
    }
    for (const style of JOIN_STYLES) {
      for (const on of [false, true]) {
        let doc = applyCommand(base, "SetJoinStyle", { style }, context.ctx).doc;
        doc = applyCommand(doc, "SetJoinSfx", { on }, context.ctx).doc;
        emit(context, `${style}${on ? "+whoosh" : ""}`, doc);
      }
    }
  }
}

function check(file) {
  const entries = JSON.parse(readFileSync(file, "utf8"));
  const out = entries.map(({ name, totalFrames: total, joins }) => {
    const valid = joinsValid(joins, total);
    const overlays = valid ? [...joinOverlays(joins)].sort((a, b) => a[0] - b[0]).map(([frame, o]) => [frame, [...o.rgb], o.alphaPm]) : null;
    return { name, valid, overlays };
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function seeds(file) {
  const entries = JSON.parse(readFileSync(file, "utf8"));
  const out = entries.map(({ name, ctx: id, seed }) => {
    const { words } = loadContext(id);
    const issues = checkDoc(seed, createContext({ words, seed }));
    return { name, issues, template: joinTemplate(seed, seed) };
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main(argv) {
  const [mode, file] = argv;
  if (mode === "docs") return docs();
  if (mode === "check" && file) return check(file);
  if (mode === "seeds" && file) return seeds(file);
  process.stderr.write("usage: transition_wiring.mjs docs | check <file> | seeds <file>\n");
  process.exitCode = 2;
  return undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
