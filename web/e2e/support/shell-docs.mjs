// Documents for the one-layout editor's specs on the fakes: the fakes' clip with one part set, built
// in Node with the real commands, so a spec can open the editor on a clip that already has music,
// a cold open or a text watermark, or another layout (openShell's `doc`). Each preset passes
// checkDoc (tests/editor-click-budget-table.test.mjs).
import { FAKE_JOB_ID, createFakeUploadClient, fakeDoc, fakeWords } from "../../components/editor/__dev__/fakes.mjs";
import { applyCommand } from "../../lib/editor/commands.mjs";
import { createContext } from "../../lib/editor/doc-model.mjs";

const words = fakeWords();
const ids = words.words.map((word) => word.id);

/** The context the commands and checkDoc run in: the fakes' words and seed. */
export function shellDocContext() {
  return createContext({ words, seed: fakeDoc() });
}

function apply(commands) {
  const ctx = shellDocContext();
  return commands.reduce((doc, [type, args]) => applyCommand(doc, type, args, ctx).doc, fakeDoc());
}

// The DTO the fakes' upload client gives for this file, as when the panel uploads it.
const MUSIC = await createFakeUploadClient().uploadAsset(FAKE_JOB_ID, { name: "lagu.m4a", size: 4096, type: "audio/mp4" }, "music");

export const SHELL_DOCS = Object.freeze({
  // "Jadi waktu itu kita datang subuh" played first (the fakes' words 6–11).
  coldOpen: () => apply([["SetColdOpen", { firstWord: ids[6], lastWord: ids[11] }]]),
  music: () => apply([["SetMusic", { asset: MUSIC.sha256, meta: MUSIC }]]),
  watermark: () => apply([["SetWatermarkText", { text: "@akun" }]]),
  fillCenter: () => apply([["SetLayout", { mode: "fill_center" }]]),
  split: () => apply([["SetLayout", { mode: "split" }]]),
});

/** The preset `name` as plain JSON, ready for addInitScript. */
export function shellDoc(name) {
  const make = SHELL_DOCS[name];
  if (!make) throw new Error(`no shell doc ${name}`);
  return JSON.parse(JSON.stringify(make()));
}
