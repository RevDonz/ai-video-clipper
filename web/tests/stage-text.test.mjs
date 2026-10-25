// stageText (lib/i18n/stage.mjs, rombak 07 §10.4): the catalog's stage.<code> for a coded
// job, the stored stageDetail for an old one, never a version word.
import assert from "node:assert/strict";
import test from "node:test";

import { createTranslator } from "use-intl/core";

import { stageText } from "../lib/i18n/stage.mjs";

const t = createTranslator({
  locale: "en-US",
  messages: { stage: { transcribe_audio: "Making the transcript", render_clip: "Rendering clip {index} of {total}" } },
});

test("a coded job reads the catalog; its params fill the message", () => {
  assert.equal(stageText(t, { stageCode: "transcribe_audio", stageDetail: "Membuat transkrip" }), "Making the transcript");
  assert.equal(stageText(t, { stageCode: "render_clip", stageParams: { index: 2, total: 5 }, stageDetail: "Merender klip 2 dari 5" }), "Rendering clip 2 of 5");
});

test("an old job, or a code the catalog does not know, shows the stored text as it is", () => {
  assert.equal(stageText(t, { stageDetail: "Transkripsi audio 40%" }), "Transkripsi audio 40%");
  assert.equal(stageText(t, { stageCode: "newer_code", stageDetail: "Teks dari worker" }), "Teks dari worker");
  assert.equal(stageText(t, { stageCode: "../x", stageDetail: "Aman" }), "Aman");
  assert.equal(stageText(t, { stageCode: "render_clip", stageParams: { n: 2 }, stageDetail: "Merender klip 2" }), "Merender klip 2", "params outside the code's contract");
  assert.equal(stageText(t, { stageDetail: "Kandidat bayangan V2 siap" }), null, "version wording stays off screen");
  assert.equal(stageText(t, null), null);
});
