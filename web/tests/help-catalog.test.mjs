// The help page's catalogue (lib/help-catalog.mjs): one entry per error code, the search that
// opens the best entry for a pasted error, and the links the pages put under their error
// messages; the entries' words in every locale's catalog (help.entries, read by
// lib/help-view.mjs). The page itself and those links in the pages: help-page.test.mjs.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { createTranslator } from "use-intl/core";

import { STORAGE_ERROR_CODES, storageMessage } from "../lib/dashboard-view.mjs";
import { DOWNLOAD_ERROR_CODES, classifyDownloadError, downloadErrorMessage } from "../lib/download-errors.mjs";
import {
  HELP_ENTRIES,
  HELP_GROUPS,
  MAX_HELP_QUERY,
  buildHelpIndex,
  findHelpEntry,
  helpAnchors,
  helpEntry,
  helpHref,
  jobHelpHref,
  llmWarningHelpHref,
  normalizeErrorText,
  storageHelpHref,
} from "../lib/help-catalog.mjs";
import { HELP_ENTRIES as ENTRY_LIST } from "../lib/help-catalog.mjs";
import { helpEntryView, helpGroupsView, helpSearchIndex, helpSearchTexts, helpTitles, shownTexts } from "../lib/help-view.mjs";
import { loadNamespace, loadNamespaces } from "../lib/i18n/catalog.mjs";
import { LOCALES } from "../lib/i18n/locales.mjs";
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

// The translators the page gets from getT(locale, namespace), built from the same catalogs.
const INTL = Object.fromEntries(LOCALES.map((entry) => [entry.code, entry.intl]));
const translator = (code, namespace) => createTranslator({ locale: INTL[code], messages: loadNamespaces(code, [namespace]), namespace });
const view = (code, entry) => helpEntryView(translator(code, "help"), translator(code, "errors"), entry);
// The index the page builds: every locale's catalog text on top of the codes and fragments.
const INDEX = await helpSearchIndex(translator);

const idOf = (text) => findHelpEntry(text, INDEX)?.entry.id ?? null;

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
  const bot = view("id", helpEntry("download_bot_check"));
  assert.equal(helpEntry("download_bot_check").action.href, "/settings");
  assert.equal(bot.action.href, "/settings");
  assert.match(bot.steps[0], /cookies YouTube di Pengaturan/);
  assert.ok(bot.steps.some((step) => /akun Google terpisah/.test(step)), "a separate Google account");
  assert.ok(bot.steps.some((step) => /[Uu]nggah file videonya/.test(step)), "uploading the file stays an option");
  assert.ok(view("id", helpEntry("download_age_restricted")).steps.some((step) => /cookies YouTube/.test(step)));
  const botEn = view("en", helpEntry("download_bot_check"));
  assert.match(botEn.steps[0], /YouTube cookies in Settings/);
  assert.ok(botEn.steps.some((step) => /separate Google account/.test(step)));
  for (const { code } of LOCALES) {
    for (const entry of HELP_ENTRIES) {
      const { cause, steps } = view(code, entry);
      for (const text of [cause, ...steps]) assert.doesNotMatch(text, /belum mendukung cookies|not support cookies/i, `${code}: ${entry.id}`);
    }
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
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.codes) && Object.isFrozen(entry.shown));
  }
  // Grouped in page order: every group's entries sit together.
  const order = HELP_ENTRIES.map((entry) => groups.indexOf(entry.group));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("each entry says what happened and how to fix it, short and without an em dash, in every locale", () => {
  for (const { code } of LOCALES) {
    for (const entry of HELP_ENTRIES) {
      const shown = view(code, entry);
      const label = `${code}: ${entry.id}`;
      const texts = [shown.title, shown.cause, ...shown.steps, ...shown.shown, shown.action?.label ?? ""];
      assert.ok(shown.title.length <= 48, `${label} title: ${shown.title}`);
      assert.ok(shown.cause.length >= 20 && shown.cause.length <= 260, `${label} cause`);
      assert.ok(shown.steps.length >= 1 && shown.steps.length <= 4, `${label} steps`);
      for (const step of shown.steps) assert.ok(step.length <= 180 && /[.)]$/.test(step), `${label} step: ${step}`);
      for (const text of texts) {
        assert.doesNotMatch(text, /—|\bV[1-3]\b|\b(?:Hot|viral)\b/, `${label}: ${text}`);
      }
      if (entry.action) assert.ok(["/dashboard", "/projects", "/settings"].includes(entry.action.href), entry.id);
    }
  }
});

test("the catalog holds exactly the entries, groups and links of the code lists, in every locale", () => {
  const ids = HELP_ENTRIES.map((entry) => entry.id).sort();
  for (const { code } of LOCALES) {
    const help = loadNamespace(code, "help");
    assert.deepEqual(Object.keys(help.entries).sort(), ids, `${code}: help.entries`);
    assert.deepEqual(Object.keys(help.groups), HELP_GROUPS.map((group) => group.id), `${code}: help.groups`);
    for (const id of ids) {
      const { title, cause, fix } = help.entries[id];
      assert.ok(typeof title === "string" && typeof cause === "string", `${code}: ${id}`);
      const steps = Object.keys(fix);
      assert.deepEqual(steps, steps.map((_, index) => String(index + 1)), `${code}: ${id} fix steps are 1..n`);
      assert.deepEqual(Object.keys(help.entries[id]).sort(), ["cause", "fix", "title"], `${code}: ${id} keys`);
    }
    for (const group of HELP_GROUPS) assert.deepEqual(Object.keys(help.groups[group.id]).sort(), ["intro", "title"], `${code}: ${group.id}`);
    const used = new Set(HELP_ENTRIES.filter((entry) => entry.action).map((entry) => entry.action.key));
    for (const key of used) assert.equal(typeof help.actions[key], "string", `${code}: help.actions.${key}`);
  }
  // Every entry reads in each language: the English page is not the Indonesian one.
  for (const entry of HELP_ENTRIES) assert.notEqual(view("en", entry).title, view("id", entry).title, entry.id);
});

test("the page's groups hold every entry once, under its anchors, in every locale", () => {
  for (const { code } of LOCALES) {
    const groups = helpGroupsView(translator(code, "help"), translator(code, "errors"));
    assert.deepEqual(groups.map((group) => group.anchor), HELP_GROUPS.map((group) => `grup-${group.id}`));
    assert.deepEqual(groups.flatMap((group) => group.entries.map((entry) => entry.id)), HELP_ENTRIES.map((entry) => entry.id));
    for (const group of groups) {
      assert.ok(group.title && group.intro, `${code}: ${group.id}`);
      for (const entry of group.entries) assert.deepEqual(entry.anchors, helpAnchors(helpEntry(entry.id)), `${code}: ${entry.id}`);
    }
    const titles = helpTitles(translator(code, "help"));
    assert.deepEqual(Object.keys(titles), HELP_ENTRIES.map((entry) => entry.id));
  }
});

test("download and storage entries quote the message the pages show for that code", () => {
  for (const code of DOWNLOAD_ERROR_CODES) assert.deepEqual(helpEntry(code).shown, [downloadErrorMessage(code).text], code);
  for (const code of STORAGE_ERROR_CODES) assert.equal(helpEntry(code).shown[0], storageMessage(code), code);
});

// A stand-in for the errors namespace of a locale whose catalog has the given messages.
function errorsWith(messages) {
  const flat = new Map(Object.entries(messages));
  return { has: (key) => flat.has(key), raw: (key) => flat.get(key) };
}

test("an entry shows the message of its code from the locale's errors catalog, else the Indonesian one", () => {
  const entry = helpEntry("download_private");
  assert.deepEqual(shownTexts(entry, errorsWith({})), [downloadErrorMessage("download_private").text]);
  assert.deepEqual(shownTexts(entry, errorsWith({ "download.download_private": "This video is private." })), ["This video is private."]);
  const timeout = helpEntry("llm_timeout");
  assert.deepEqual(shownTexts(timeout, errorsWith({})), [], "AI codes carry no Indonesian text of their own");
  assert.deepEqual(shownTexts(timeout, errorsWith({ "llm.timeout": "Too slow.", "llm.deadline": "Too slow." })), ["Too slow."]);
  assert.deepEqual(shownTexts(helpEntry("storage_free_space_low"), errorsWith({ "storage.storage_free_space_low": "Disk almost full." })), ["Disk almost full."]);
});

test("the search knows every locale: a message pasted from either UI language opens its entry", () => {
  // The index the page uses is built over every registered locale, enabled or not.
  const id = loadNamespace("id", "help").entries;
  const en = loadNamespace("en", "help").entries;
  assert.equal(idOf(en.download_stalled.cause), "download_stalled");
  assert.equal(idOf(id.download_stalled.cause), "download_stalled");
  assert.equal(findHelpEntry("download progress stopped moving", INDEX)?.entry.id, "download_stalled");
  assert.equal(findHelpEntry("download progress stopped moving", INDEX)?.by, "words");
  assert.equal(idOf(en.download_bot_check.title), "download_bot_check");
  assert.equal(idOf(en.storage_free_space_low.title), "storage_free_space_low");
  // The messages each UI language shows on screen open their entry, whichever language the page is in.
  for (const { code } of LOCALES) {
    for (const entry of HELP_ENTRIES) {
      for (const text of view(code, entry).shown) assert.equal(idOf(text), entry.id, `${code}: ${text}`);
    }
  }
  // Once a locale's errors catalog has the on-screen messages (i18n M2), they are fragments too:
  // the Indonesian one keeps working in the English UI, and the English one is found as text.
  const english = { ...helpSearchTexts(translator("en", "help"), errorsWith({ "download.download_private": "This video is private and cannot be fetched." })) };
  const indonesian = helpSearchTexts(translator("id", "help"), translator("id", "errors"));
  const index = buildHelpIndex([indonesian, english]);
  assert.deepEqual(findHelpEntry("This video is private and cannot be fetched.", index), { entry: helpEntry("download_private"), by: "text" });
  assert.deepEqual(findHelpEntry(downloadErrorMessage("download_private").text, index), { entry: helpEntry("download_private"), by: "text" });
});

test("the index is plain data the server can hand to the search box", () => {
  const copy = JSON.parse(JSON.stringify(INDEX));
  assert.deepEqual(Object.keys(copy), ENTRY_LIST.map((entry) => entry.id));
  for (const value of Object.values(copy)) {
    assert.ok(Array.isArray(value.fragments) && typeof value.words === "string");
    for (const fragment of value.fragments) assert.equal(fragment, normalizeErrorText(fragment).replace(/[.!?]+$/, ""));
  }
  assert.equal(findHelpEntry("unduhan berhenti tidak bergerak", copy)?.entry.id, "download_stalled", "a copy searches the same");
  // Without the catalogs the codes, the Indonesian messages and the fragments still work.
  assert.equal(findHelpEntry("download_bot_check")?.entry.id, "download_bot_check");
  assert.equal(findHelpEntry(downloadErrorMessage("download_private").text)?.entry.id, "download_private");
  assert.equal(findHelpEntry("Kena rate limit openrouter")?.entry.id, "llm_rate_limited");
  assert.equal(findHelpEntry("unduhan berhenti tidak bergerak"), null, "the loose words live in the catalogs");
  for (const bad of [null, undefined, 42, "nope"]) assert.equal(findHelpEntry("download_private", bad)?.entry.id, "download_private");
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
  const found = findHelpEntry("unduhan berhenti tidak bergerak", INDEX);
  assert.equal(found?.entry.id, "download_stalled");
  assert.equal(found.by, "words");
});

test("nothing that fits returns null, and a huge paste keeps only its end, where a log puts the error", () => {
  for (const text of ["", "   ", "halo", "apa kabar semua", "hello how are you", null, undefined, 42]) {
    assert.equal(findHelpEntry(text, INDEX), null, String(text));
    assert.equal(findHelpEntry(text), null, String(text));
  }
  assert.ok(MAX_HELP_QUERY >= 2000);
  assert.equal(idOf(`${"[download] 10.0% of 1.2GiB\n".repeat(400)}ERROR: [youtube] AbCdEfGhIjK: Private video`), "download_private");
  assert.equal(findHelpEntry(`download_private ${"x".repeat(MAX_HELP_QUERY)}`, INDEX), null, "text before the last MAX_HELP_QUERY characters is not read");
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
