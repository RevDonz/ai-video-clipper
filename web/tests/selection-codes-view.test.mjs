// The project page reads the coded reasons and warnings of i18n M5 (lib/i18n/stage.mjs) through
// selection-v3-view: clipReasonTexts for "Kenapa dipilih", a label option for selectionNotices.
// Jobs without codes keep the stored Indonesian text.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createTranslator } from "use-intl/core";

import { warningText } from "../lib/i18n/stage.mjs";
import { clipReasonTexts, clipReasons, selectionNotices, selectionWarningLabel } from "../lib/selection-v3-view.mjs";

const WEB = new URL("..", import.meta.url);
const catalog = async (locale) => JSON.parse(await readFile(new URL(`messages/${locale}/reason.json`, WEB), "utf8"));
const translator = async (locale) => createTranslator({ locale, messages: { reason: await catalog(locale) } });

const reasons = ["Dibuka dengan penanda cerita/anekdot sehingga penonton langsung masuk ke kisahnya.", "Peringkat ulang LLM: 4,8/10"];
const coded = { reasons, reasonCodes: [{ code: "open_story", params: {} }, { code: "llm_rerank", params: { score: 4.8 } }] };

test("coded reasons read the catalog, without the rerank bookkeeping", async () => {
  const en = await translator("en");
  assert.deepEqual(clipReasonTexts(en, coded), [(await catalog("en")).open_story]);
  const id = await translator("id");
  assert.deepEqual(clipReasonTexts(id, coded), clipReasons(coded), "Indonesian is the engine's own text");
});

test("a clip without valid codes keeps its stored reasons", async () => {
  const en = await translator("en");
  assert.deepEqual(clipReasonTexts(en, { reasons }), clipReasons({ reasons }));
  assert.deepEqual(clipReasonTexts(en, { reasons, reasonCodes: [{ code: "nope", params: {} }] }), clipReasons({ reasons }));
  assert.deepEqual(clipReasonTexts(en, null), []);
});

test("selectionNotices words its warnings through the label it is given", async () => {
  const en = await translator("en");
  const job = { selectionV3: { mode: "v3", status: "completed", source: "llm", warnings: ["trend_items_skipped:2"] } };
  const [plain] = selectionNotices(job);
  assert.equal(plain.text, selectionWarningLabel("trend_items_skipped:2"));
  const [worded] = selectionNotices(job, { label: (code) => warningText(en, code) });
  assert.equal(worded.text, "2 broken trend items skipped.");
  assert.notEqual(worded.text, plain.text);
  assert.equal(worded.href, plain.href);
  const [fallback] = selectionNotices(job, { label: () => null });
  assert.equal(fallback.text, plain.text, "a label without text falls back to the Indonesian one");
});
