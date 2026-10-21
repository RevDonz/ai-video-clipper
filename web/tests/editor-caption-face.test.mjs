// The caption over the speaker's face (CONTRACTS §5.50): the plan's `caption_over_face` warning,
// its message, and the one-click fix that moves the caption to the preset the warning names.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fakeDoc, fakePlan, fakeWords } from "../components/editor/__dev__/fakes.mjs";
import {
  CAPTION_NOTES,
  CAPTION_POSITIONS,
  captionFaceFix,
  captionFaceNote,
} from "../components/editor/panels/caption-model.mjs";
import { MESSAGES, actionableChecks, checksView } from "../components/editor/shell-model.mjs";
import { createContext } from "../lib/editor/doc-model.mjs";
import { createEditSession } from "../lib/editor/history.mjs";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => readFileSync(path.join(WEB, relative), "utf8");
const FACE = { code: "caption_over_face", path: "/captions/overrides/y_e5", ref: "tengah", f: 18 };

test("the warning's message is the engine's", () => {
  assert.equal(MESSAGES.caption_over_face, "Caption menutupi wajah pembicara");
});

test("the fix is the preset the warning names, as the Posisi pills send it", () => {
  for (const option of CAPTION_POSITIONS) {
    const fix = captionFaceFix({ ...FACE, ref: option.id });
    assert.deepEqual(fix, {
      id: option.id,
      label: `Pindah ke ${option.label}`,
      command: { type: "SetCaptionOverride", args: { key: "y_e5", value: option.value }, mergeKey: null },
    });
  }
  assert.equal(captionFaceFix({ ...FACE, ref: null }), null, "no preset clears the face");
  assert.equal(captionFaceFix({ ...FACE, ref: "kiri" }), null);
  assert.equal(captionFaceFix({ ...FACE, code: "unsafe_zone" }), null);
  assert.equal(captionFaceFix(null), null);
});

test("captionFaceNote: the caption views' warning with its fix, or none", () => {
  const seed = fakeDoc();
  const plan = (warnings) => ({ ...fakePlan(seed), warnings });
  assert.equal(captionFaceNote(plan([])), null);
  assert.equal(captionFaceNote(null), null);
  assert.deepEqual(captionFaceNote(plan([{ code: "unsafe_zone", path: "/captions/overrides/y_e5" }, FACE])), {
    text: CAPTION_NOTES.overFace,
    fix: captionFaceFix(FACE),
  });
  assert.equal(CAPTION_NOTES.overFace, "Caption menutupi wajah pembicara.");
  assert.deepEqual(captionFaceNote(plan([{ ...FACE, ref: undefined }])),
    { text: CAPTION_NOTES.overFaceNoFix, fix: null });
});

test("it is a check before export, at the auto clip's spot too", () => {
  const seed = fakeDoc();
  const plan = { ...fakePlan(seed), fps: [25, 1], errors: [], warnings: [FACE] };
  const checks = checksView({ warnings: [], plan, doc: structuredClone(seed), seed });
  assert.deepEqual(checks.map(({ code, severity, ref, f, message }) => ({ code, severity, ref, f, message })), [
    { code: "caption_over_face", severity: "warning", ref: "tengah", f: 18, message: MESSAGES.caption_over_face },
  ]);
  assert.equal(actionableChecks(checks).length, 1);
  assert.deepEqual(captionFaceFix(checks[0]), captionFaceFix(FACE), "a check carries what its fix needs");
});

test("the fix moves the caption in one undo step", () => {
  const seed = fakeDoc();
  const session = createEditSession({ doc: seed, ctx: createContext({ words: fakeWords(), seed }), now: () => 0 });
  const { command } = captionFaceFix(FACE);
  session.dispatch(command.type, command.args, { mergeKey: command.mergeKey });
  assert.equal(session.doc.captions.overrides.y_e5, 60000);
  assert.equal(session.history.size, 1);
  session.undo();
  assert.equal(session.doc.captions.overrides.y_e5, seed.captions.overrides.y_e5);
});

test("Perlu dicek, the Caption card and the Teks panel offer the fix", () => {
  const panel = read("components/editor/ChecksPanel.jsx");
  assert.match(panel, /captionFaceFix\(check\)/);
  assert.match(panel, /onFix\(fix\.command\)/);
  for (const file of ["components/editor/quick/CaptionCard.jsx", "components/editor/panels/TextPanel.jsx"]) {
    const source = read(file);
    assert.match(source, /captionFaceNote\(/, file);
    assert.match(source, /data-caption-face/, file);
  }
  const app = read("components/editor/EditorApp.jsx");
  assert.match(app, /onFix=\{readOnly \? null : /);
});
