// Stage, reason and warning codes (rombak 07 §10.4, i18n M5): the web lists match the engine's
// (src/ai_clipper/i18n_codes.py), every code has a message in every locale and nothing else is in
// the stage and reason catalogs, the helpers format every code, and a job or clip without codes
// (written before them) shows its own text.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTranslator } from "use-intl/core";

import { loadNamespace, loadNamespaces } from "../lib/i18n/catalog.mjs";
import { i18nHandlers } from "../lib/i18n/handlers.mjs";
import { LOCALES, localeEntry } from "../lib/i18n/locales.mjs";
import {
  REASON_CODES, REASON_PARAMS, REASON_TAGS, STAGE_CODES, STAGE_PARAMS, TEXT_REASON, WARNING_CODES, WARNING_PARAMS,
  reasonText, reasonTexts, sanitizeReasonCodes, sanitizeStageCode, sanitizeWarningCodes, stageText, warningCode,
  warningCodes, warningText,
} from "../lib/i18n/stage.mjs";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function python() {
  const configured = process.env.PYTHON_BIN;
  if (configured) return configured.includes(path.sep) ? path.resolve(configured) : configured;
  return path.join(REPO, ".venv", "bin", "python");
}

function engine(script) {
  const out = execFileSync(python(), ["-c", script], { cwd: REPO, env: { ...process.env, PYTHONPATH: path.join(REPO, "src") }, encoding: "utf8" });
  return JSON.parse(out);
}

function translator(locale) {
  const messages = loadNamespaces(locale, ["common", "stage", "reason"]);
  return createTranslator({ locale: localeEntry(locale).intl, messages, ...i18nHandlers({ locale, strict: true, unavailable: messages.common.unavailable }) });
}

const sample = (type, name) => (type === "string" ? `Contoh ${name}` : type === "tags" ? ["confession", "number"] : name === "ratio" ? 0.35 : 3);

test("the web lists are the engine's (i18n_codes.py)", () => {
  const codes = engine(`
import json
from ai_clipper import i18n_codes as c
print(json.dumps({"stage": c.STAGE_CODES, "reason": c.REASON_CODES, "tags": c.REASON_TAGS,
                  "warnings": {k: list(v) for k, v in c.WARNING_PARAMS.items()}, "text": c.TEXT_REASON}))`);
  for (const code of codes.stage) assert.ok(STAGE_CODES.includes(code), `stage ${code}`);
  assert.deepEqual([...REASON_CODES].sort(), [...codes.reason].sort());
  assert.deepEqual([...REASON_TAGS], codes.tags);
  assert.deepEqual(Object.fromEntries(Object.entries(WARNING_PARAMS).map(([code, names]) => [code, [...names]])), codes.warnings);
  assert.equal(TEXT_REASON, codes.text);
});

test("every code has a message in every locale, and the catalogs hold nothing else", () => {
  for (const { code: locale } of LOCALES) {
    const stage = loadNamespace(locale, "stage");
    assert.deepEqual(Object.keys(stage).sort(), [...STAGE_CODES].sort(), `${locale}: stage`);
    const { tag, warning, ...reasons } = loadNamespace(locale, "reason");
    assert.deepEqual(Object.keys(reasons).sort(), [...REASON_CODES].sort(), `${locale}: reason`);
    assert.deepEqual(Object.keys(tag).sort(), [...REASON_TAGS].sort(), `${locale}: reason.tag`);
    assert.deepEqual(Object.keys(warning).sort(), [...WARNING_CODES].sort(), `${locale}: reason.warning`);
  }
});

test("stageText formats every stage code in every locale", () => {
  for (const { code: locale } of LOCALES) {
    const t = translator(locale);
    for (const [code, names] of Object.entries(STAGE_PARAMS)) {
      const params = Object.fromEntries(names.map((name) => [name, 3]));
      const text = stageText(t, { stageCode: code, stageParams: params, stageDetail: "Teks lama" });
      assert.ok(text && text !== "Teks lama" && !text.includes("{"), `${locale}: ${code} -> ${text}`);
    }
  }
  const en = translator("en");
  assert.equal(stageText(en, { stageCode: "render_clip", stageParams: { index: 2, total: 5 } }), "Rendering clip 2 of 5");
  assert.equal(stageText(translator("id"), { stageCode: "render_clip", stageParams: { index: 2, total: 5 } }), "Merender klip 2 dari 5");
  assert.equal(stageText(en, { stageCode: "transcribe_progress", stageParams: { percent: 40 } }), "Transcribing audio 40%");
});

test("a job without a stage code, or with a broken one, shows its own detail (old jobs)", () => {
  const t = translator("en");
  assert.equal(stageText(t, { stageDetail: "Mendengarkan dan menulis transkrip" }), "Mendengarkan dan menulis transkrip");
  assert.equal(stageText(t, { stageCode: "nope", stageDetail: "Teks lama" }), "Teks lama");
  assert.equal(stageText(t, { stageCode: "render_clip", stageParams: { index: "2" }, stageDetail: "Teks lama" }), "Teks lama");
  assert.equal(stageText(t, { stageDetail: "Kandidat bayangan V2 siap" }), null, "version wording stays off screen");
  assert.equal(stageText(t, {}), null);
  assert.equal(stageText(t, null), null);
});

test("sanitizeStageCode keeps a known code and its numeric params only", () => {
  assert.deepEqual(sanitizeStageCode("finalizing", { extra: 1 }), { stageCode: "finalizing", stageParams: null });
  assert.deepEqual(sanitizeStageCode("render_clip", { index: 1, total: 2, x: "y" }), { stageCode: "render_clip", stageParams: { index: 1, total: 2 } });
  assert.deepEqual(sanitizeStageCode("render_clip", { index: 1 }), { stageCode: null, stageParams: null });
  assert.deepEqual(sanitizeStageCode("render_clip", { index: -1, total: 2 }), { stageCode: null, stageParams: null });
  for (const bad of ["__proto__", "toString", "", null, 7, "Stage"]) assert.deepEqual(sanitizeStageCode(bad, {}), { stageCode: null, stageParams: null }, String(bad));
});

test("reasonText formats every reason code in every locale; the LLM's words stay as written", () => {
  for (const { code: locale } of LOCALES) {
    const t = translator(locale);
    for (const [code, types] of Object.entries(REASON_PARAMS)) {
      const params = Object.fromEntries(Object.entries(types).map(([name, type]) => [name, sample(type, name)]));
      const text = reasonText(t, { code, params });
      assert.ok(text && !text.includes("{"), `${locale}: ${code} -> ${text}`);
    }
    assert.equal(reasonText(t, { code: TEXT_REASON, params: { text: "Momen lucu dari AI." } }), "Momen lucu dari AI.");
  }
  const id = translator("id");
  const en = translator("en");
  assert.equal(
    reasonText(id, { code: "hook_line_tagged", params: { offset: 4, text: "Gue keluar", tags: ["confession", "number"] } }),
    "Kalimat hook terkuat di detik ke-4: “Gue keluar” (pengakuan, angka/uang).",
  );
  assert.equal(reasonText(en, { code: "hook_line", params: { offset: 4, text: "Gue keluar" } }), "Strongest hook line at second 4: “Gue keluar”.");
  assert.equal(reasonText(id, { code: "cold_open", params: { seconds: 4.5 } }), "Cold open: kalimat hook (4,5 detik) diputar lebih dulu.");
  assert.equal(reasonText(en, { code: "cold_open", params: { seconds: 4.5 } }), "Cold open: the hook line (4.5 s) plays first.");
  assert.equal(reasonText(id, { code: "silence", params: { ratio: 0.35 } }), "Ritme bicara lega: rasio hening 35% di atas rata-rata episode.");
  assert.equal(reasonText(id, { code: "llm_rerank", params: { score: 7 } }), "Peringkat ulang LLM: 7,0/10");
  assert.equal(reasonText(en, { code: "laughs", params: { count: 1 } }), "1 laugh in the clip.");
  assert.equal(reasonText(en, { code: "laughs", params: { count: 2 } }), "2 laughs in the clip.");
});

test("a clip's reasons: the coded ones when every entry is valid, else its own text (old jobs)", () => {
  const t = translator("en");
  const reasons = ["Dimulai di batas kalimat yang bersih.", "Alasan dari AI."];
  const reasonCodes = [{ code: "open_plain", params: {} }, { code: "text", params: { text: "Alasan dari AI." } }];
  assert.deepEqual(reasonTexts(t, { reasons, reasonCodes }), ["Starts at a clean sentence boundary.", "Alasan dari AI."]);
  assert.deepEqual(reasonTexts(t, { reasons }), reasons);
  assert.deepEqual(reasonTexts(t, { reasons, reasonCodes: [...reasonCodes, { code: "nope", params: {} }] }), reasons);
  assert.deepEqual(reasonTexts(t, {}), []);
  assert.equal(sanitizeReasonCodes([{ code: "trend", params: { title: "a\u0000b" } }]), null);
  assert.equal(sanitizeReasonCodes([{ code: "hook_line_tagged", params: { offset: 1, text: "x", tags: ["nope"] } }]), null);
  assert.equal(sanitizeReasonCodes([]), null);
  assert.deepEqual(sanitizeReasonCodes([{ code: "laughs", params: { count: 2, extra: "x" } }]), [{ code: "laughs", params: { count: 2 } }]);
});

test("warningCode splits code[:detail] by the code's params", () => {
  assert.deepEqual(warningCode("llm_disabled"), { code: "llm_disabled", params: {} });
  assert.deepEqual(warningCode("few_clips:3"), { code: "few_clips", params: { count: 3 } });
  assert.deepEqual(warningCode("thumbnail_failed:2"), { code: "thumbnail_failed", params: { clip: 2 } });
  assert.deepEqual(warningCode("groq_fallback:no_key"), { code: "groq_fallback", params: { detail: "no_key" } });
  assert.deepEqual(warningCode("audio_unavailable"), { code: "audio_unavailable", params: {} });
  assert.deepEqual(warningCode("llm_retry:next_model:2"), { code: "llm_retry", params: { mode: "next_model", count: 2 } });
  assert.deepEqual(warningCode("llm_dropped:3:too_short"), { code: "llm_dropped", params: { count: 3, detail: "too_short" } });
  assert.deepEqual(warningCode("llm_chunk_failed:2:rate_limited"), { code: "llm_chunk_failed", params: { chunk: 2, detail: "rate_limited" } });
  assert.deepEqual(warningCode("pipeline_failed:llm"), { code: "pipeline_failed", params: { detail: "llm" } });
  for (const bad of ["nope", "few_clips", "few_clips:x", "llm_disabled:1", "llm_retry:next_model", "__proto__", "", null, 5]) {
    assert.equal(warningCode(bad), null, String(bad));
  }
  assert.deepEqual(warningCodes(["few_clips:2", "nope", "llm_disabled"]), [{ code: "few_clips", params: { count: 2 } }, { code: "llm_disabled", params: {} }]);
  assert.deepEqual(warningCodes("few_clips:2"), []);
});

test("the engine splits warnings the same way", () => {
  const samples = ["llm_disabled", "few_clips:3", "thumbnail_failed:2", "groq_fallback:no_key", "audio_unavailable", "audio_unavailable:timeout",
    "llm_retry:next_model:2", "llm_dropped:3:too_short", "llm_chunk_failed:2:rate_limited", "pipeline_failed:llm", "punctuation_collapse:10-20",
    "focus_few_matches:0", "nope", "few_clips", "few_clips:x", "llm_disabled:1", "llm_retry:next_model"];
  const fromEngine = engine(`
import json
from ai_clipper.i18n_codes import warning_code
print(json.dumps([warning_code(item) for item in ${JSON.stringify(samples)}]))`);
  assert.deepEqual(samples.map(warningCode), fromEngine);
});

test("warningText formats every warning code in every locale, from an entry or a string", () => {
  for (const { code: locale } of LOCALES) {
    const t = translator(locale);
    for (const [code, names] of Object.entries(WARNING_PARAMS)) {
      const params = Object.fromEntries(names.map((name) => [name, ["count", "clip", "chunk"].includes(name) ? 2 : "abc"]));
      const text = warningText(t, { code, params });
      assert.ok(text && !text.includes("{"), `${locale}: ${code} -> ${text}`);
    }
    assert.ok(warningText(t, "audio_unavailable"));
  }
  const en = translator("en");
  const id = translator("id");
  assert.equal(warningText(id, "groq_fallback:no_key"), "Groq tidak dipakai (belum ada API key Groq); transkrip dibuat dengan Whisper di server ini.");
  assert.equal(warningText(en, "focus_few_matches:0"), "No moment matches the focus; every clip is another best moment, labeled “Outside focus”.");
  assert.equal(warningText(en, "thumbnail_failed:2"), "The cover image of clip 2 could not be made.");
  assert.equal(warningText(en, "nope:1"), null);
  assert.deepEqual(sanitizeWarningCodes([{ code: "clip_failed", params: { clip: 1 } }, { code: "nope", params: {} }, { code: "clip_failed", params: { clip: "1" } }]), [{ code: "clip_failed", params: { clip: 1 } }]);
  assert.equal(sanitizeWarningCodes([]), null);
  assert.equal(sanitizeWarningCodes("clip_failed:1"), null);
});
