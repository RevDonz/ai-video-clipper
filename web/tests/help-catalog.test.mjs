// The help page's catalogue (lib/help-catalog.mjs): one entry per error code, the search that
// opens the best entry for a pasted error, and the links the pages put under their error
// messages. The page itself and those links in the pages: help-page.test.mjs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { STORAGE_ERROR_CODES, storageMessage } from "../lib/dashboard-view.mjs";
import { DOWNLOAD_ERROR_CODES, classifyDownloadError, downloadErrorMessage } from "../lib/download-errors.mjs";
import {
  HELP_ENTRIES,
  HELP_GROUPS,
  MAX_HELP_QUERY,
  findHelpEntry,
  helpAnchors,
  helpEntry,
  helpHref,
  jobHelpHref,
  llmWarningHelpHref,
  normalizeErrorText,
  storageHelpHref,
} from "../lib/help-catalog.mjs";
import { CHECK_CODES, checkMessage } from "../lib/llm-settings-actions.mjs";
import { selectionNotices } from "../lib/selection-v3-view.mjs";

const run = promisify(execFile);
const WEB = fileURLToPath(new URL("..", import.meta.url));
const ROOT = path.join(WEB, "..");

function pythonBin() {
  return process.env.PYTHON_BIN || "../.venv/bin/python";
}

async function engineErrorCodes() {
  const script = "import json; from ai_clipper.llm import ERROR_CODES; print(json.dumps(ERROR_CODES))";
  const { stdout } = await run(pythonBin(), ["-c", script], { cwd: WEB, env: { PATH: process.env.PATH } });
  return JSON.parse(stdout);
}

const idOf = (text) => findHelpEntry(text)?.entry.id ?? null;

// --- Every code has an entry ----------------------------------------------------------------

test("every download code has its own entry, anchored at the code itself", () => {
  for (const code of DOWNLOAD_ERROR_CODES) {
    const entry = helpEntry(code);
    assert.ok(entry, code);
    assert.equal(entry.id, code);
    assert.equal(entry.group, "unduhan");
    assert.equal(helpHref(code), `/bantuan#${code}`);
  }
});

test("a bot check and an age gate point to the YouTube cookies in Pengaturan", () => {
  const bot = helpEntry("download_bot_check");
  assert.equal(bot.action.href, "/settings");
  assert.match(bot.steps[0], /cookies YouTube di Pengaturan/);
  assert.ok(bot.steps.some((step) => /akun Google terpisah/.test(step)), "a separate Google account");
  assert.ok(bot.steps.some((step) => /[Uu]nggah file videonya/.test(step)), "uploading the file stays an option");
  assert.ok(helpEntry("download_age_restricted").steps.some((step) => /cookies YouTube/.test(step)));
  for (const entry of HELP_ENTRIES) {
    for (const text of [entry.cause, ...entry.steps]) assert.doesNotMatch(text, /belum mendukung cookies/i, entry.id);
  }
});

test("every storage code has an entry, and the editor's lost reservation shares one", () => {
  assert.deepEqual(STORAGE_ERROR_CODES, ["storage_quota_exhausted", "storage_free_space_low", "storage_admission_unavailable"]);
  for (const code of STORAGE_ERROR_CODES) {
    assert.equal(helpEntry(code)?.id, code, code);
    assert.equal(helpEntry(code).group, "penyimpanan");
  }
  assert.equal(helpEntry("storage_admission_lost")?.id, "storage_admission_unavailable");
});

test("every code the engine's LLM errors carry has an entry, also with the llm_ prefix", async () => {
  const codes = await engineErrorCodes();
  assert.ok(codes.includes("quota_exhausted") && codes.includes("rate_limited") && codes.includes("context_length"));
  for (const code of codes) {
    const entry = helpEntry(code);
    assert.ok(entry, `no help entry for the LLM error code ${code}`);
    assert.equal(entry.group, "ai", code);
    assert.equal(helpEntry(`llm_${code}`), entry, code);
    assert.match(helpHref(code), /^\/bantuan#llm_[a-z_]+$/, code);
  }
  for (const code of ["http_400", "http_418", "http_500", "http_503"]) assert.equal(helpEntry(code)?.id, "llm_http", code);
  assert.equal(helpEntry("http_5xx"), null);
});

test("every result code of the settings page's connection test has an entry", () => {
  assert.ok(CHECK_CODES.includes("ok") && CHECK_CODES.includes("key_unreadable"));
  for (const code of CHECK_CODES.filter((item) => item !== "ok")) {
    assert.equal(helpEntry(code)?.group, "ai", code);
  }
});

test("every AI fallback the engine records in a job's warnings has an entry", async () => {
  const sources = await Promise.all(["pipeline.py", "selection_v3.py"].map((name) => readFile(path.join(ROOT, "src/ai_clipper", name), "utf8")));
  const failed = new Set(sources.flatMap((source) => [...source.matchAll(/["']llm_failed:([a-z_]+)["']/g)].map((match) => match[1])));
  assert.ok(failed.has("deadline") && failed.has("no_moments"));
  for (const code of failed) assert.ok(helpEntry(`llm_failed:${code}`), `llm_failed:${code}`);
  for (const code of ["llm_unavailable", "llm_disabled", "llm_not_configured"]) {
    assert.ok(sources.some((source) => source.includes(`"${code}"`)), `${code} is still written by the engine`);
    assert.equal(helpEntry(code)?.id, "llm_not_configured", code);
  }
  assert.equal(helpEntry("llm_unavailable:missing_api_key")?.id, "llm_missing_api_key");
  assert.equal(helpEntry("llm_failed:quota_exhausted")?.id, "llm_quota_exhausted");
});

test("an unknown or malformed code has no entry and no link", () => {
  for (const code of [null, undefined, 42, "", "download", "llm_failed", "llm_failed:", "script_exhausted", "pipeline_failed:render", "__proto__", "constructor", "toString"]) {
    assert.equal(helpEntry(code), null, String(code));
    assert.equal(helpHref(code), null, String(code));
  }
});

// --- The catalogue itself ----------------------------------------------------------------

test("entries are unique, grouped, and every anchor is a safe id", () => {
  const groups = HELP_GROUPS.map((group) => group.id);
  assert.deepEqual(groups, ["unduhan", "penyimpanan", "ai"]);
  const anchors = HELP_ENTRIES.flatMap(helpAnchors);
  assert.equal(new Set(anchors).size, anchors.length, "no anchor is used twice");
  for (const entry of HELP_ENTRIES) {
    assert.ok(groups.includes(entry.group), entry.id);
    assert.equal(helpAnchors(entry)[0], entry.id);
    for (const anchor of helpAnchors(entry)) {
      assert.match(anchor, /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/, anchor);
      assert.equal(helpEntry(anchor), entry, anchor);
    }
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.steps));
  }
  // Grouped in page order: every group's entries sit together.
  const order = HELP_ENTRIES.map((entry) => groups.indexOf(entry.group));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("each entry says what happened and how to fix it, in short Indonesian without an em dash", () => {
  for (const entry of HELP_ENTRIES) {
    const texts = [entry.title, entry.cause, ...entry.steps, ...entry.shown, entry.action?.label ?? ""];
    assert.ok(entry.title.length <= 48, `${entry.id} title: ${entry.title}`);
    assert.ok(entry.cause.length >= 20 && entry.cause.length <= 260, `${entry.id} cause`);
    assert.ok(entry.steps.length >= 1 && entry.steps.length <= 4, `${entry.id} steps`);
    for (const step of entry.steps) assert.ok(step.length <= 180 && /[.)]$/.test(step), `${entry.id} step: ${step}`);
    for (const text of texts) {
      assert.doesNotMatch(text, /—|\bV[1-3]\b|\b(?:Hot|viral)\b/, `${entry.id}: ${text}`);
    }
    if (entry.action) assert.ok(["/dashboard", "/projects", "/settings"].includes(entry.action.href), entry.id);
  }
});

test("download and storage entries quote the message the pages show for that code", () => {
  for (const code of DOWNLOAD_ERROR_CODES) assert.deepEqual(helpEntry(code).shown, [downloadErrorMessage(code).text], code);
  for (const code of STORAGE_ERROR_CODES) assert.equal(helpEntry(code).shown[0], storageMessage(code), code);
});

// --- Search: by code first, then by known message fragments ------------------------------------

test("a pasted code opens its entry, whatever surrounds it", () => {
  assert.deepEqual(findHelpEntry("download_bot_check"), { entry: helpEntry("download_bot_check"), by: "code" });
  assert.equal(idOf("Kode: storage_free_space_low"), "storage_free_space_low");
  assert.equal(idOf("GAGAL [quota_exhausted]: Kuota openrouter untuk model x habis."), "llm_quota_exhausted");
  assert.equal(idOf("warnings: llm_failed:rate_limited, llm_filled:2"), "llm_rate_limited");
  assert.equal(idOf("llm_unavailable:missing_api_key"), "llm_missing_api_key");
  assert.equal(idOf("https://potongin.example/bantuan#llm_context_length"), "llm_context_length");
  assert.equal(idOf("Tes gagal (kode: timeout)."), "llm_timeout");
  assert.equal(idOf("HTTP_503 dari penyedia"), "llm_http");
  // The code decides even when the words would point elsewhere.
  assert.equal(idOf("download_private: Kena rate limit penyedia."), "download_private");
});

test("a single-word code counts only where the text marks it as a code", () => {
  // "timeout" and "network" are ordinary words in an error line; only [timeout] or kode: timeout name the code.
  assert.equal(findHelpEntry("[network]").by, "code");
  assert.notEqual(findHelpEntry("socket network unreachable")?.by, "code");
});

test("each message the pages show for a download or storage code opens that code's entry", () => {
  for (const code of DOWNLOAD_ERROR_CODES) {
    const { text, hint } = downloadErrorMessage(code);
    assert.equal(idOf(text), code, text);
    assert.equal(idOf(`${text} ${hint}`), code, `${text} ${hint}`);
    assert.equal(idOf(text.replace(/\.$/, "").toUpperCase()), code, "case and the final period do not matter");
  }
  for (const code of STORAGE_ERROR_CODES) assert.equal(idOf(storageMessage(code)), code, code);
  assert.equal(idOf("Penyimpanan server tidak cukup untuk melanjutkan job"), "storage_quota_exhausted");
  assert.equal(idOf("Pemeriksaan penyimpanan tidak tersedia"), "storage_admission_unavailable");
  assert.equal(idOf("kuota penyimpanan habis"), "storage_quota_exhausted");
});

test("raw yt-dlp lines open the entry of the code the worker would store", () => {
  const lines = [
    "ERROR: [youtube] AbCdEfGhIjK: Private video. Sign in if you've been granted access to this video.",
    "ERROR: [youtube] AbCdEfGhIjK: Video unavailable. This video has been removed by the uploader",
    "ERROR: [youtube:truncated_id] AbCdE: Incomplete YouTube ID AbCdE. URL https://www.youtube.com/watch?v=AbCdE looks truncated.",
    "ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm your age. This video may be inappropriate for some users.",
    "ERROR: [youtube] AbCdEfGhIjK: Join this channel to get access to members-only content like this video, and other exclusive perks.",
    "ERROR: [youtube] AbCdEfGhIjK: Video unavailable. The uploader has not made this video available in your country",
    "ERROR: [youtube] AbCdEfGhIjK: Sign in to confirm you’re not a bot. This helps protect our community.",
    "ERROR: [youtube] AbCdEfGhIjK: This content isn't available, try again later. The current session has been rate-limited by YouTube for up to an hour.",
    "ERROR: unable to download video data: HTTP Error 429: Too Many Requests",
    "ERROR: [youtube] AbCdEfGhIjK: Requested format is not available. Use --list-formats for a list of available formats",
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
  ];
  for (const line of lines) {
    const stored = classifyDownloadError(line).code;
    assert.notEqual(stored, "download_failed", line);
    assert.equal(idOf(line), stored, line);
    // Without the ERROR: prefix, as the project page shows it under "Pesan dari server".
    assert.equal(idOf(line.replace(/^ERROR:\s*/, "")), stored, line);
  }
});

test("each connection-test message of the settings page opens that code's entry", () => {
  for (const code of CHECK_CODES.filter((item) => item !== "ok")) {
    assert.equal(idOf(checkMessage(code)), helpEntry(code).id, `${code}: ${checkMessage(code)}`);
  }
  assert.equal(idOf(checkMessage("http_502")), "llm_http");
  assert.equal(idOf(checkMessage("http_418")), "llm_http");
  assert.equal(idOf(checkMessage("weird_code")), "llm_http");
});

test("the engine's own LLM messages and common provider replies open the right entry", () => {
  const cases = [
    ["Kena rate limit openrouter untuk model qwen/qwen3:free.", "llm_rate_limited"],
    ["Error code: 429 - {'error': {'message': 'Rate limit exceeded: free-models-per-min.'}}", "llm_rate_limited"],
    ["Kuota openrouter untuk model x habis atau harus menunggu lama; model ini dilewati sementara.", "llm_quota_exhausted"],
    ["You exceeded your current quota, please check your plan and billing details.", "llm_quota_exhausted"],
    ["API key ditolak oleh groq (HTTP 401). Periksa API key di .env.", "llm_auth"],
    ["Error code: 401 - Invalid API Key", "llm_auth"],
    ["Model x tidak ditemukan atau tidak tersedia di openrouter; ID model mungkin sudah berganti.", "llm_model_not_found"],
    ["No endpoints found for model qwen/qwen3:free", "llm_model_not_found"],
    ["Prompt terlalu panjang untuk model x; perkecil POTONGIN_LLM_CONTEXT_TOKENS.", "llm_context_length"],
    ["This model's maximum context length is 32768 tokens.", "llm_context_length"],
    ["Permintaan ke groq (x) melewati batas waktu 45 s.", "llm_timeout"],
    ["LLM tidak selesai memilih momen dalam 1200 detik.", "llm_timeout"],
    ["Tidak bisa terhubung ke custom (hermes).", "llm_network"],
    ["Jawaban model x terpotong karena batas token output; naikkan POTONGIN_LLM_MAX_OUTPUT_TOKENS.", "llm_truncated"],
    ["Model x tidak mengembalikan satu objek JSON yang valid.", "llm_bad_response"],
    ["Model x di openrouter butuh kredit/langganan berbayar; model ini dilewati.", "llm_payment_required"],
    ["Anggaran konteks LLM terlalu kecil untuk standar klip dan transkrip (potongan transkrip terlalu pendek).", "llm_context_too_small"],
    ["LLM tidak memberi satu pun momen yang valid.", "llm_no_moments"],
    ["LLM belum dikonfigurasi; atur POTONGIN_LLM_PROVIDER dan API key-nya.", "llm_not_configured"],
    ["Jawaban model x diblokir filter konten openrouter.", "llm_content_filter"],
  ];
  for (const [text, id] of cases) assert.equal(idOf(text), id, text);
});

test("the text is compared without case, quotes or extra spaces", () => {
  assert.equal(normalizeErrorText("  Sign in to confirm\n you’re   NOT a “bot”  "), "sign in to confirm youre not a bot");
  assert.equal(normalizeErrorText("ｄｏｗｎｌｏａｄ＿ｐｒｉｖａｔｅ"), "download_private");
  assert.equal(normalizeErrorText(null), "");
  assert.equal(idOf("“Video   ini PRIVAT”"), "download_private");
});

test("loose words still find an entry when most of them fit it", () => {
  const found = findHelpEntry("unduhan berhenti tidak bergerak");
  assert.equal(found?.entry.id, "download_stalled");
  assert.equal(found.by, "words");
});

test("nothing that fits returns null, and a huge paste keeps only its end, where a log puts the error", () => {
  for (const text of ["", "   ", "halo", "apa kabar semua", null, undefined, 42]) assert.equal(findHelpEntry(text), null, String(text));
  assert.ok(MAX_HELP_QUERY >= 2000);
  assert.equal(idOf(`${"[download] 10.0% of 1.2GiB\n".repeat(400)}ERROR: [youtube] AbCdEfGhIjK: Private video`), "download_private");
  assert.equal(findHelpEntry(`download_private ${"x".repeat(MAX_HELP_QUERY)}`), null, "text before the last MAX_HELP_QUERY characters is not read");
});

// --- Links from the pages ----------------------------------------------------------------------

test("a failed job links to the entry of its download or storage code, nothing else does", () => {
  assert.equal(jobHelpHref({ status: "failed", errorCode: "download_bot_check", error: "Sign in to confirm" }), "/bantuan#download_bot_check");
  assert.equal(jobHelpHref({ status: "failed", errorCode: null, error: "storage_admission_unavailable" }), "/bantuan#storage_admission_unavailable");
  assert.equal(jobHelpHref({ status: "failed", error: " storage_free_space_low " }), "/bantuan#storage_free_space_low");
  assert.equal(jobHelpHref({ status: "failed", errorCode: "download_nope", error: "ai-clipper gagal (exit 1)" }), null);
  assert.equal(jobHelpHref({ status: "failed", error: "quota_exhausted" }), null, "a job error is not an LLM code");
  assert.equal(jobHelpHref({ status: "completed", errorCode: "download_private" }), null);
  assert.equal(jobHelpHref(null), null);
});

test("a storage code from the dashboard's banner or a refused job links to its entry; other API codes do not", () => {
  for (const code of STORAGE_ERROR_CODES) assert.equal(storageHelpHref(code), `/bantuan#${code}`, code);
  for (const code of ["queue_capacity_reached", "invalid_request", "csrf_rejected", "timeout", "download_private", null]) {
    assert.equal(storageHelpHref(code), null, String(code));
  }
});

test("an AI fallback links to the entry of the reason the engine recorded", () => {
  assert.equal(llmWarningHelpHref(["llm_unavailable:missing_api_key", "llm_unavailable"]), "/bantuan#llm_missing_api_key");
  assert.equal(llmWarningHelpHref(["no_word_timestamps", "llm_failed:quota_exhausted"]), "/bantuan#llm_quota_exhausted");
  assert.equal(llmWarningHelpHref(["llm_failed:deadline"]), "/bantuan#llm_timeout");
  assert.equal(llmWarningHelpHref(["llm_failed:script_exhausted", "llm_not_configured"]), "/bantuan#llm_not_configured");
  assert.equal(llmWarningHelpHref(["llm_disabled"]), "/bantuan#llm_not_configured");
  assert.equal(llmWarningHelpHref(["llm_filled:2", "focus_topup_failed:rate_limited"]), null);
  assert.equal(llmWarningHelpHref(null), null);

  const summary = { mode: "v3", status: "fallback", source: "heuristic", warnings: ["llm_failed:rate_limited"] };
  const [notice] = selectionNotices({ options: { llmMode: "auto" }, selectionV3: summary });
  assert.equal(notice.help, "/bantuan#llm_rate_limited");
  const [bare] = selectionNotices({ options: { llmMode: "auto" }, selectionV3: { ...summary, warnings: [] } });
  assert.equal(bare.help, null);
});

test("every help link the helpers build points at an anchor the page renders", () => {
  const anchors = new Set(HELP_ENTRIES.flatMap(helpAnchors));
  const hrefs = [
    ...DOWNLOAD_ERROR_CODES, ...STORAGE_ERROR_CODES, ...CHECK_CODES.filter((code) => code !== "ok"),
    "http_502", "llm_failed:deadline", "llm_unavailable",
  ].map(helpHref);
  for (const href of hrefs) {
    assert.match(href, /^\/bantuan#/);
    assert.ok(anchors.has(href.slice("/bantuan#".length)), href);
  }
});
